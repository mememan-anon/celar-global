import { readFile, writeFile, mkdir } from 'node:fs/promises';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');

const SURGE_APP_ORIGIN = 'https://app.surge.xyz';
const SURGE_BACKEND_URL = 'https://back.surge.xyz';
const PRIVY_BASE_URL = 'https://auth.privy.io';
const PRIVY_APP_ID = 'cmheubr2q0175h20c1a8xcg3l';
const DEFAULT_AUTH_TOKEN_OUTPUT_PATH = path.join(projectRoot, 'data', 'surge-inspect-latest', 'surge-auth-token.json');

function stripWrappingQuotes(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }

  return text;
}

function normalizeBearerToken(value) {
  const token = stripWrappingQuotes(value);
  return token.toLowerCase().startsWith('bearer ') ? token.slice(7).trim() : token;
}

function parseCookieString(value) {
  const raw = stripWrappingQuotes(value).replace(/^cookie:\s*/i, '').trim();
  if (!raw) {
    return {};
  }

  return Object.fromEntries(
    raw
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes('='))
      .map((part) => {
        const [key, ...valueParts] = part.split('=');
        return [key.trim(), valueParts.join('=').trim()];
      })
      .filter(([key, cookieValue]) => key && cookieValue),
  );
}

async function loadEnvFile() {
  try {
    const raw = await readFile(envPath, 'utf8');
    const entries = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        continue;
      }

      const [key, ...rest] = trimmed.split('=');
      entries[key.trim()] = stripWrappingQuotes(rest.join('='));
    }

    return entries;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function readFirstSetting(args, envFile, argKey, envKeys, fallbackValue) {
  if (args[argKey] !== undefined) {
    return args[argKey];
  }

  for (const envKey of envKeys) {
    const value = process.env[envKey] ?? envFile[envKey];
    if (value !== undefined) {
      return value;
    }
  }

  return fallbackValue;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function createPkcePair() {
  const verifier = nodeCrypto.randomBytes(36).toString('base64url');
  const challenge = nodeCrypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function createStateCode() {
  return nodeCrypto.randomBytes(36).toString('base64url');
}

function tryParseJsonText(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Origin: SURGE_APP_ORIGIN,
      Referer: `${SURGE_APP_ORIGIN}/`,
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = tryParseJsonText(text);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data,
  };
}

async function requestPrivyJson(privyAccessToken, endpointPath, { method = 'POST', body } = {}) {
  return requestJson(`${PRIVY_BASE_URL}${endpointPath}`, {
    method,
    headers: {
      ...(privyAccessToken ? { Authorization: `Bearer ${privyAccessToken}` } : {}),
      'privy-app-id': PRIVY_APP_ID,
      'privy-client': 'surge-x-auth-signup/1.0',
    },
    body,
  });
}

async function requestSurgeJson(accessToken, endpointPath, { method = 'GET', body } = {}) {
  return requestJson(`${SURGE_BACKEND_URL}${endpointPath}`, {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body,
  });
}

function extractUrlFromPayload(payload) {
  const directCandidates = [payload?.url, payload?.connectUrl, payload?.authorizationUrl, payload?.authUrl];
  const directMatch = directCandidates.find((candidate) => typeof candidate === 'string' && /^https?:\/\//i.test(candidate));
  if (directMatch) {
    return directMatch.trim();
  }

  return '';
}

function extractBackendLoginTokens(payload) {
  const candidate = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const accessToken = candidate?.accessToken ?? null;
  const refreshToken = candidate?.refreshToken ?? null;

  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    isNewUser: candidate?.isNewUser ?? null,
  };
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function runXOAuthInBrowser({ connectUrl, xAuthToken, xCsrfToken }) {
  const normalizedUrl = connectUrl.replace(/^https:\/\/twitter\.com\//i, 'https://x.com/');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const cookieExpires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const twitterCookies = ['.twitter.com', 'twitter.com', '.x.com', 'x.com'].flatMap((domain) => [
    {
      name: 'auth_token',
      value: xAuthToken,
      domain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      expires: cookieExpires,
    },
    ...(xCsrfToken
      ? [
          {
            name: 'ct0',
            value: xCsrfToken,
            domain,
            path: '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax',
            expires: cookieExpires,
          },
        ]
      : []),
  ]);

  try {
    await context.addCookies(twitterCookies);
    const observedUrls = [];
    const messages = [];
    const rememberUrl = (url) => {
      if (typeof url === 'string' && url && !observedUrls.includes(url)) {
        observedUrls.push(url);
      }
    };

    const opener = await context.newPage();
    await opener.exposeFunction('capturePrivyOAuthMessage', (payload) => {
      messages.push(payload);
    });
    await opener.addInitScript(() => {
      window.addEventListener('message', (event) => {
        window.capturePrivyOAuthMessage({ origin: event.origin, data: event.data });
      });
    });
    await opener.goto(`${SURGE_APP_ORIGIN}/profile`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    const popupPromise = opener.waitForEvent('popup', { timeout: 15000 });
    await opener.evaluate((url) => window.open(url, '_blank', 'popup=1,width=440,height=680'), normalizedUrl);
    const page = await popupPromise;
    page.on('request', (request) => rememberUrl(request.url()));
    page.on('response', (response) => rememberUrl(response.url()));

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const currentUrl = page.url();
      rememberUrl(currentUrl);
      const oauthMessage = messages.find((message) => message?.data?.type === 'PRIVY_OAUTH_RESPONSE');
      if (oauthMessage) {
        await page.waitForTimeout(1000);
        break;
      }

      await page
        .evaluate(() => {
          const labels = ['Authorize app', 'Authorize', 'Allow', 'Connect', 'Sign in', 'Log in'];
          const elements = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a'));
          const target = elements.find((element) => {
            const text = `${element.innerText || element.textContent || element.value || element.getAttribute('aria-label') || ''}`.trim();
            return labels.some((label) => text.toLowerCase() === label.toLowerCase() || text.toLowerCase().includes(label.toLowerCase()));
          });

          if (target) {
            target.click();
          }
        })
        .catch(() => {});
      await page.waitForTimeout(2500);
    }

    const finalUrl = page.url();
    rememberUrl(finalUrl);
    const oauthMessage = messages.find((message) => message?.data?.type === 'PRIVY_OAUTH_RESPONSE') ?? null;
    return {
      finalUrl,
      callbackUrl: observedUrls.find((url) => url.includes('auth.privy.io/api/v1/oauth/callback')) || '',
      observedUrls,
      oauthMessage,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = await loadEnvFile();
  const rawX = readFirstSetting(args, envFile, 'x-token', ['x-auth', 'X_AUTH', 'X_ACCESS_TOKEN', 'X_AUTH_TOKEN', 'X_BEARER_TOKEN', 'TWITTER_ACCESS_TOKEN', 'TWITTER_AUTH_TOKEN', 'TWITTER_BEARER_TOKEN'], '');
  const parsedXCookie = parseCookieString(rawX);
  const xAuthToken = normalizeBearerToken(parsedXCookie.auth_token ?? parsedXCookie['auth-token'] ?? rawX);
  const xCsrfToken = stripWrappingQuotes(
    readFirstSetting(args, envFile, 'x-csrf-token', ['X_CT0', 'X_CSRF_TOKEN', 'TWITTER_CT0', 'TWITTER_CSRF_TOKEN'], parsedXCookie.ct0 ?? '') ?? '',
  );

  if (!xAuthToken) {
    throw new Error('Missing X auth token. Set x-auth, X_AUTH_TOKEN, X_ACCESS_TOKEN, X_AUTH_TOKEN, or TWITTER_AUTH_TOKEN in .env.');
  }

  const stateCode = createStateCode();
  const pkce = createPkcePair();
  console.log('Starting Privy X OAuth login/signup flow ...');
  const init = await requestPrivyJson('', '/api/v1/oauth/init', {
    method: 'POST',
    body: {
      provider: 'twitter',
      redirect_to: `${SURGE_APP_ORIGIN}/profile`,
      code_challenge: pkce.challenge,
      state_code: stateCode,
    },
  });

  if (!init.ok) {
    const message = init.data?.message || init.data?.error || init.statusText || 'Request failed';
    throw new Error(`Privy X OAuth init failed with ${init.status}: ${message}`);
  }

  const connectUrl = extractUrlFromPayload(init.data);
  if (!connectUrl) {
    throw new Error(`Privy X OAuth init did not return a URL: ${JSON.stringify(init.data)}`);
  }

  console.log('Authorizing X account in browser ...');
  const browserResult = await runXOAuthInBrowser({ connectUrl, xAuthToken, xCsrfToken });
  console.log(`X OAuth final URL: ${browserResult.finalUrl}`);
  if (browserResult.callbackUrl) {
    console.log(`X OAuth callback URL: ${browserResult.callbackUrl}`);
  }

  const callbackSearchParams = browserResult.callbackUrl ? new URL(browserResult.callbackUrl).searchParams : new URLSearchParams();
  const finalSearchParams = new URL(browserResult.finalUrl).searchParams;
  const authorizationCode =
    browserResult.oauthMessage?.data?.authorizationCode ||
    browserResult.oauthMessage?.data?.authorization_code ||
    finalSearchParams.get('privy_oauth_code') ||
    callbackSearchParams.get('code') ||
    callbackSearchParams.get('authorization_code') ||
    finalSearchParams.get('code') ||
    finalSearchParams.get('authorization_code') ||
    '';
  const returnedState =
    browserResult.oauthMessage?.data?.stateCode ||
    browserResult.oauthMessage?.data?.state_code ||
    finalSearchParams.get('privy_oauth_state') ||
    callbackSearchParams.get('state') ||
    callbackSearchParams.get('state_code') ||
    finalSearchParams.get('state') ||
    finalSearchParams.get('state_code') ||
    stateCode;
  if (!authorizationCode) {
    throw new Error(
      `X OAuth browser flow did not return an authorization code. Final URL: ${browserResult.finalUrl}. ` +
        `Observed URLs: ${browserResult.observedUrls.slice(-10).join(' | ')}`,
    );
  }

  console.log('Authenticating Privy session with X OAuth code ...');
  const authenticateBodies = [
    // This matches Privy's frontend AuthFlow (`Qa.authenticate`) exactly for OAuth login/signup.
    {
      authorization_code: authorizationCode,
      state_code: returnedState,
      code_verifier: pkce.verifier,
      mode: 'login-or-sign-up',
    },
    // Older Privy internal client (`loginWithCode`) also sends `code_type`.
    {
      authorization_code: authorizationCode,
      code_type: 'authorization_code',
      state_code: returnedState,
      code_verifier: pkce.verifier,
      mode: 'login-or-sign-up',
    },
    {
      authorization_code: authorizationCode,
      code_type: 'code',
      state_code: returnedState,
      code_verifier: pkce.verifier,
      mode: 'login-or-sign-up',
    },
  ];
  let privyAuth = null;
  let lastPrivyAuth = null;

  for (const body of authenticateBodies) {
    const attempt = await requestPrivyJson('', '/api/v1/oauth/authenticate', {
      method: 'POST',
      body,
    });
    lastPrivyAuth = attempt;

    if (attempt.ok) {
      privyAuth = attempt;
      break;
    }

    console.log(`Privy authenticate shape failed with ${attempt.status}: ${JSON.stringify(attempt.data).slice(0, 500)}`);
  }

  if (!privyAuth?.ok) {
    const message = lastPrivyAuth?.data?.message || lastPrivyAuth?.data?.error || lastPrivyAuth?.statusText || 'Request failed';
    throw new Error(`Privy X OAuth authenticate failed with ${lastPrivyAuth?.status}: ${message}`);
  }

  const tokenCandidates = [
    { source: 'token', value: privyAuth.data?.token },
    { source: 'identity_token', value: privyAuth.data?.identity_token },
  ].filter((candidate) => typeof candidate.value === 'string' && candidate.value.trim());

  let surgeTokens = null;
  let surgeTokenSource = '';
  for (const candidate of tokenCandidates) {
    console.log(`Trying Surge backend login with ${candidate.source} ...`);
    const login = await requestSurgeJson('', '/auth/login', {
      method: 'POST',
      body: {
        type: 'PRIVY',
        code: candidate.value,
      },
    });
    const tokens = extractBackendLoginTokens(login.data);
    if (login.ok && tokens) {
      surgeTokens = tokens;
      surgeTokenSource = candidate.source;
      break;
    }

    console.log(`/auth/login with ${candidate.source} failed with ${login.status}: ${JSON.stringify(login.data)}`);
  }

  if (!surgeTokens?.accessToken) {
    throw new Error('Privy X OAuth authenticate succeeded, but Surge backend /auth/login did not return access and refresh tokens.');
  }

  const outputPath = args['auth-token-output']
    ? path.resolve(projectRoot, String(args['auth-token-output']))
    : DEFAULT_AUTH_TOKEN_OUTPUT_PATH;
  await writeJsonFile(outputPath, {
    accessToken: surgeTokens.accessToken,
    refreshToken: surgeTokens.refreshToken,
    tokenSource: surgeTokenSource,
    privyUserId: privyAuth.data?.user?.id ?? null,
    xAccount: privyAuth.data?.user?.twitter ?? null,
    capturedAt: new Date().toISOString(),
  });
  console.log(`Wrote Surge auth token payload to ${outputPath}.`);

  const me = await requestSurgeJson(surgeTokens.accessToken, '/auth/me');
  if (!me.ok) {
    throw new Error(`/auth/me failed with ${me.status}: ${JSON.stringify(me.data)}`);
  }

  console.log(`/auth/me: ${JSON.stringify(me.data).slice(0, 3000)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
