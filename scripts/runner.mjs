import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeCrypto from 'node:crypto';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');

const SURGE_APP_ORIGIN = 'https://app.surge.xyz';
const SURGE_WEB_ORIGIN = 'https://surge.xyz';
const SURGE_BACKEND_URL = 'https://back.surge.xyz';
const PRIVY_BASE_URL = 'https://auth.privy.io';
const PRIVY_APP_ID = 'cmheubr2q0175h20c1a8xcg3l';
const DEFAULT_MODE = 'login-or-sign-up';
const SONJJ_BASE_URL = 'https://app.sonjj.com';
const DEFAULT_PROJECT_ID = '28';
const DEFAULT_PROJECT_IGNITES = 'max';
const DEFAULT_MAX_PROJECT_IGNITES = 15;
const DEFAULT_EMAIL_LIMIT =  2100;
const DEFAULT_BATCH_DELAY_MIN_MS = 5000;   // 5 seconds
const DEFAULT_BATCH_DELAY_MAX_MS = 30000;  // 30 seconds
const DEFAULT_OTP_WAIT_MS = 10000;
const DEFAULT_OTP_POLL_ATTEMPTS = 3;
const DEFAULT_NETWORK_RETRY_ATTEMPTS = 2;
const DEFAULT_NETWORK_RETRY_DELAY_MS = 1500;
const EXPECTED_OTP_SENDERS = ['no-reply@privy.io', 'no-reply@mail.privy.io'];
const EXPECTED_OTP_SUBJECT = 'Your login code for Surge';
const SONJJ_MAILBOX_CONFIG = {
  'outlook.com': {
    provider: 'outlook',
    inboxPath: '/v1/temp_outlook/inbox',
    messagePath: '/v1/temp_outlook/message',
  },
  'gmail.com': {
    provider: 'gmail',
    inboxPath: '/v1/temp_gmail/inbox',
    messagePath: '/v1/temp_gmail/message',
  },
};
const IDENTITY_POOL_DIR = path.join(projectRoot, 'data', 'identity-pool');
const NAMES_POOL_PATH = path.join(IDENTITY_POOL_DIR, 'names.json');
const DESCRIPTIONS_POOL_PATH = path.join(IDENTITY_POOL_DIR, 'descriptions.json');
const MY_EMAIL_POOL_PATH = path.join(IDENTITY_POOL_DIR, 'my-email.json');
const USED_IDENTITIES_PATH = path.join(IDENTITY_POOL_DIR, 'used-identities.json');
const X_AUTH_POOL_PATH = path.join(IDENTITY_POOL_DIR, 'you-auth-pool.txt');
const REFUSED_IDENTITIES_PATH = path.join(IDENTITY_POOL_DIR, 'refused-identities.json');
const RESERVED_IDENTITIES_PATH = path.join(IDENTITY_POOL_DIR, 'reserved-identities.json');
const IDENTITY_POOL_LOCK_PATH = path.join(IDENTITY_POOL_DIR, '.identity-pool.lock');
const DEFAULT_IDENTITY_POOL_LOCK_TIMEOUT_MS = 120000;
const IDENTITY_POOL_LOCK_RETRY_MS = 250;
const MESSAGE_ARRAY_HINT_KEYS = ['data', 'messages', 'items', 'results', 'value'];
let identityPoolWriteQueue = Promise.resolve();

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

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  if (typeof headers.raw === 'function') {
    return headers.raw()['set-cookie'] ?? [];
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function parseSetCookie(setCookie, requestUrl) {
  const url = new URL(requestUrl);
  const parts = setCookie.split(';').map((part) => part.trim()).filter(Boolean);
  const [nameValue, ...attributeParts] = parts;
  const separatorIndex = nameValue.indexOf('=');

  if (separatorIndex <= 0) {
    return null;
  }

  const cookie = {
    name: nameValue.slice(0, separatorIndex),
    value: nameValue.slice(separatorIndex + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: null,
  };

  for (const attribute of attributeParts) {
    const [rawKey, ...rawValueParts] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rawValueParts.join('=').trim();

    if (key === 'domain' && value) {
      cookie.domain = value.startsWith('.') ? value.slice(1) : value;
      continue;
    }

    if (key === 'path' && value) {
      cookie.path = value;
      continue;
    }

    if (key === 'secure') {
      cookie.secure = true;
      continue;
    }

    if (key === 'httponly') {
      cookie.httpOnly = true;
      continue;
    }

    if (key === 'samesite' && value) {
      cookie.sameSite = value;
      continue;
    }

    if (key === 'expires' && value) {
      cookie.expires = value;
      continue;
    }

    if (key === 'max-age' && value) {
      const maxAgeSeconds = Number(value);
      if (Number.isFinite(maxAgeSeconds)) {
        cookie.expires = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();
      }
    }
  }

  return cookie;
}

function createCookieJar() {
  const cookies = [];

  function matchesRequest(cookie, url) {
    const hostname = url.hostname;
    const pathname = url.pathname || '/';
    const domainMatch = hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
    const pathMatch = pathname.startsWith(cookie.path || '/');
    const notExpired = !cookie.expires || Number.isNaN(Date.parse(cookie.expires)) || Date.parse(cookie.expires) > Date.now();
    return domainMatch && pathMatch && notExpired;
  }

  return {
    addFromResponse(response, requestUrl) {
      for (const setCookie of extractSetCookies(response.headers)) {
        const parsed = parseSetCookie(setCookie, requestUrl);
        if (!parsed) {
          continue;
        }

        const existingIndex = cookies.findIndex(
          (cookie) =>
            cookie.name === parsed.name &&
            cookie.domain === parsed.domain &&
            cookie.path === parsed.path,
        );

        if (existingIndex >= 0) {
          cookies.splice(existingIndex, 1, parsed);
        } else {
          cookies.push(parsed);
        }
      }
    },

    getCookieHeader(requestUrl) {
      const url = new URL(requestUrl);
      const headerParts = cookies
        .filter((cookie) => matchesRequest(cookie, url))
        .map((cookie) => `${cookie.name}=${cookie.value}`);

      return headerParts.join('; ');
    },

  };
}

async function executeFetchWithRetry(requestFactory, label) {
  let lastError = null;

  for (let attemptNumber = 1; attemptNumber <= DEFAULT_NETWORK_RETRY_ATTEMPTS; attemptNumber += 1) {
    try {
      return await requestFactory();
    } catch (error) {
      lastError = error;
      if (attemptNumber >= DEFAULT_NETWORK_RETRY_ATTEMPTS) {
        break;
      }

      console.warn(
        `${label} failed on attempt ${attemptNumber}/${DEFAULT_NETWORK_RETRY_ATTEMPTS}. ` +
          `Retrying in ${DEFAULT_NETWORK_RETRY_DELAY_MS}ms ...`,
      );
      await sleep(DEFAULT_NETWORK_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function fetchJsonWithCookies(jar, url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const cookieHeader = jar.getCookieHeader(url);

  if (cookieHeader) {
    headers.set('Cookie', cookieHeader);
  }

  const response = await executeFetchWithRetry(
    () =>
      fetch(url, {
        ...options,
        headers,
        redirect: options.redirect ?? 'follow',
      }),
    `Request to ${url}`,
  );

  jar.addFromResponse(response, url);

  const text = await response.text();
  const data = tryParseJsonText(text);

  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data,
  };
}

function buildPrivyHeaders(clientAnalyticsId, privyAccessToken = '', origin = SURGE_APP_ORIGIN) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: origin,
    Referer: `${origin}/`,
    ...(privyAccessToken ? { Authorization: `Bearer ${privyAccessToken}` } : {}),
    'privy-app-id': PRIVY_APP_ID,
    'privy-ca-id': clientAnalyticsId,
    'privy-client': 'react-auth:2.25.0',
  };
}

function buildSurgeHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SURGE_APP_ORIGIN,
    Referer: `${SURGE_APP_ORIGIN}/`,
  };
}

function buildAuthTokenCandidates(authResponse) {
  const ordered = [
    { source: 'token', value: authResponse?.token },
    { source: 'privy_access_token', value: authResponse?.privy_access_token },
    { source: 'identity_token', value: authResponse?.identity_token },
  ];

  const seen = new Set();

  return ordered.filter(({ value }) => {
    if (typeof value !== 'string' || !value.trim()) {
      return false;
    }

    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return true;
  });
}

function getBackendLoginTokens(payload) {
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

async function fetchAuthedJson(accessToken, endpointPath, { method = 'GET', body } = {}) {
  const response = await fetch(`${SURGE_BACKEND_URL}${endpointPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = tryParseJsonText(text);

  if (!response.ok) {
    const message = data?.message || data?.error || response.statusText || 'Request failed';
    throw new Error(`${endpointPath} failed with ${response.status}: ${message}`);
  }

  return data;
}

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

function createPkcePair() {
  const verifier = nodeCrypto.randomBytes(36).toString('base64url');
  const challenge = nodeCrypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function createStateCode() {
  return nodeCrypto.randomBytes(36).toString('base64url');
}

async function runXPrivyOAuthLinkInBrowser({ connectUrl, xAuthToken }) {
  const normalizedUrl = connectUrl.replace(/^https:\/\/twitter\.com\//i, 'https://x.com/');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const cookieExpires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const twitterCookies = ['.twitter.com', 'twitter.com', '.x.com', 'x.com'].map((domain) => ({
    name: 'auth_token',
    value: xAuthToken,
    domain,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    expires: cookieExpires,
  }));

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
    await opener.goto(`${SURGE_WEB_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    const popupPromise = opener.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await opener.evaluate((url) => window.open(url, '_blank', 'popup=1,width=440,height=680'), normalizedUrl);
    const page = (await popupPromise) ?? opener;
    page.on('request', (request) => rememberUrl(request.url()));
    page.on('response', (response) => rememberUrl(response.url()));

    for (let attempt = 0; attempt < 35; attempt += 1) {
      rememberUrl(page.url());
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
            const text = `${element.innerText || element.textContent || element.value || element.getAttribute('aria-label') || ''}`.trim().toLowerCase();
            return labels.some((label) => text === label.toLowerCase() || text.includes(label.toLowerCase()));
          });

          if (target) {
            target.click();
          }
        })
        .catch(() => {});
      await page.waitForTimeout(2000);
    }

    const finalUrl = page.url();
    rememberUrl(finalUrl);
    const callbackUrl = observedUrls.find((url) => url.includes('auth.privy.io/api/v1/oauth/callback')) || '';
    const callbackSearchParams = callbackUrl ? new URL(callbackUrl).searchParams : new URLSearchParams();
    const finalSearchParams = new URL(finalUrl).searchParams;
    const oauthMessage = messages.find((message) => message?.data?.type === 'PRIVY_OAUTH_RESPONSE') ?? null;
    const authorizationCode =
      oauthMessage?.data?.authorizationCode ||
      oauthMessage?.data?.authorization_code ||
      finalSearchParams.get('privy_oauth_code') ||
      callbackSearchParams.get('code') ||
      callbackSearchParams.get('authorization_code') ||
      finalSearchParams.get('code') ||
      finalSearchParams.get('authorization_code') ||
      '';
    const returnedState =
      oauthMessage?.data?.stateCode ||
      oauthMessage?.data?.state_code ||
      finalSearchParams.get('privy_oauth_state') ||
      callbackSearchParams.get('state') ||
      callbackSearchParams.get('state_code') ||
      finalSearchParams.get('state') ||
      finalSearchParams.get('state_code') ||
      '';

    return { finalUrl, callbackUrl, observedUrls, oauthMessage, authorizationCode, returnedState };
  } finally {
    await browser.close();
  }
}

async function requestPrivyOAuthLink({ cookieJar, clientAnalyticsId, privyAccessToken, authorizationCode, returnedState, codeVerifier }) {
  const link = await fetchJsonWithCookies(cookieJar, `${PRIVY_BASE_URL}/api/v1/oauth/link`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId, privyAccessToken, SURGE_WEB_ORIGIN),
    body: JSON.stringify({
      authorization_code: authorizationCode,
      state_code: returnedState,
      code_verifier: codeVerifier,
    }),
  });

  if (!link.ok && link.data?.code !== 'cannot_link_more_of_type') {
    throw new Error(`Privy X OAuth link failed with ${link.status}: ${JSON.stringify(link.data)}`);
  }

  return {
    ok: link.ok,
    alreadyLinked: link.data?.code === 'cannot_link_more_of_type',
    data: link.data,
  };
}

async function syncSurgePrivyUser({ accessToken, privyAccessToken, logPrefix }) {
  const response = await fetch(`${SURGE_BACKEND_URL}/auth/privy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: SURGE_APP_ORIGIN,
      Referer: `${SURGE_APP_ORIGIN}/`,
    },
    body: JSON.stringify({ token: privyAccessToken }),
  });
  const text = await response.text();
  const data = tryParseJsonText(text);
  console.log(`${logPrefix}/auth/privy sync response ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
}

async function connectXAccountWithPrivyOAuthLink({ cookieJar, clientAnalyticsId, accessToken, privyAccessToken, xAuthToken, logPrefix }) {
  if (!xAuthToken) {
    console.log(`${logPrefix}No X auth token provided; skipping X Privy OAuth link attempt.`);
    return false;
  }

  if (!privyAccessToken) {
    console.log(`${logPrefix}No Privy access token returned from email auth; skipping X Privy OAuth link attempt.`);
    return false;
  }

  const pkce = createPkcePair();
  const stateCode = createStateCode();
  console.log(`${logPrefix}Issuing Privy X OAuth link URL ...`);
  const init = await fetchJsonWithCookies(cookieJar, `${PRIVY_BASE_URL}/api/v1/oauth/init`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId, privyAccessToken, SURGE_WEB_ORIGIN),
    body: JSON.stringify({
      provider: 'twitter',
      redirect_to: `${SURGE_WEB_ORIGIN}/`,
      code_challenge: pkce.challenge,
      state_code: stateCode,
    }),
  });

  if (!init.ok) {
    throw new Error(`Privy X OAuth init failed with ${init.status}: ${JSON.stringify(init.data)}`);
  }

  const connectUrl = init.data?.url || init.data?.connectUrl || init.data?.authorizationUrl || '';
  if (!connectUrl) {
    throw new Error(`Privy X OAuth init did not return URL: ${JSON.stringify(init.data)}`);
  }

  console.log(`${logPrefix}Authorizing X app in browser for Privy link ...`);
  const browserResult = await runXPrivyOAuthLinkInBrowser({ connectUrl, xAuthToken });
  console.log(`${logPrefix}Privy X OAuth final URL: ${browserResult.finalUrl}`);
  if (!browserResult.authorizationCode) {
    throw new Error(`Privy X OAuth did not return authorization code. Observed URLs: ${browserResult.observedUrls.slice(-10).join(' | ')}`);
  }

  const linkResult = await requestPrivyOAuthLink({
    cookieJar,
    clientAnalyticsId,
    privyAccessToken,
    authorizationCode: browserResult.authorizationCode,
    returnedState: browserResult.returnedState || stateCode,
    codeVerifier: pkce.verifier,
  });
  if (linkResult.alreadyLinked) {
    console.log(`${logPrefix}Privy X OAuth link already exists for this account type; syncing Surge user instead.`);
  } else {
    console.log(`${logPrefix}Privy X OAuth link result: ${JSON.stringify(linkResult.data).slice(0, 1000)}`);
  }

  await syncSurgePrivyUser({ accessToken, privyAccessToken, logPrefix });

  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const meAfterLink = await fetchAuthedJson(accessToken, '/auth/me');
    const socials = getAuthMeSocials(meAfterLink);
    console.log(`${logPrefix}/auth/me socials after Privy X link attempt ${attemptNumber}/3: ${JSON.stringify(socials)}`);

    if (hasXSocialConnection(meAfterLink)) {
      return true;
    }

    if (attemptNumber < 3) {
      await syncSurgePrivyUser({ accessToken, privyAccessToken, logPrefix });
      await sleep(2000);
    }
  }

  return false;
}

function findProjectAllocations(projectCapacity, projectId) {
  const allocations = Array.isArray(projectCapacity?.allocations) ? projectCapacity.allocations : [];
  return allocations.filter((entry) => {
    const value = String(
      entry?.project_id ??
        entry?.token_project_id ??
        entry?.projectId ??
        entry?.project?.id ??
        '',
    ).trim();

    return value === String(projectId ?? '').trim();
  });
}

async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

function isNumericString(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

// Use this when a payload must be valid JSON and parsing failures should stop execution
// with a file or request-specific error message.
function parseJsonTextWithContext(text, contextLabel) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON in ${contextLabel}: ${message}`);
  }
}

// Use this when responses may be JSON or plain text and callers can safely continue with
// either representation.
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

async function readJsonFileWithDefault(filePath, fallbackValue) {
  if (!existsSync(filePath)) {
    return fallbackValue;
  }

  const raw = await readFile(filePath, 'utf8');
  if (!raw.trim()) {
    return fallbackValue;
  }

  return parseJsonTextWithContext(raw, filePath);
}

async function loadStringArrayFile(filePath, label, { keepEmpty = false } = {}) {
  const payload = await readJsonFileWithDefault(filePath, []);
  if (!Array.isArray(payload)) {
    throw new Error(`${label} file must contain a top-level JSON array of strings: ${filePath}`);
  }

  const normalizedValues = payload.map((value) => String(value ?? '').trim());
  return keepEmpty ? normalizedValues : normalizedValues.filter(Boolean);
}

async function readIdentityRecordFile(filePath, label) {
  const payload = await readJsonFileWithDefault(filePath, []);
  if (!Array.isArray(payload)) {
    throw new Error(`${label} file must contain a JSON array: ${filePath}`);
  }

  return payload;
}

async function writeJsonFile(filePath, payload) {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function acquireIdentityPoolLock() {
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(IDENTITY_POOL_LOCK_PATH);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= DEFAULT_IDENTITY_POOL_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for identity pool lock after ${DEFAULT_IDENTITY_POOL_LOCK_TIMEOUT_MS}ms.`,
        );
      }

      await sleep(IDENTITY_POOL_LOCK_RETRY_MS);
    }
  }
}

async function releaseIdentityPoolLock() {
  await rm(IDENTITY_POOL_LOCK_PATH, { recursive: true, force: true });
}

async function withIdentityPoolLock(task) {
  await ensureDirectory(IDENTITY_POOL_DIR);
  await acquireIdentityPoolLock();

  try {
    return await task();
  } finally {
    await releaseIdentityPoolLock();
  }
}

function validateEmailPoolEntry(entry, index, filePath, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} entry at index ${index} must be an object with email and timestamp in ${filePath}`);
  }

  const email = String(entry.email ?? '').trim();
  if (!email) {
    throw new Error(`${label} entry at index ${index} is missing a non-empty email in ${filePath}`);
  }

  const timestamp = String(entry.timestamp ?? '').trim();
  if (!isNumericString(timestamp)) {
    throw new Error(`${label} entry at index ${index} must have a numeric timestamp in ${filePath}`);
  }

  return {
    email,
    timestamp,
  };
}

async function loadEmailEntryPoolFile(filePath, label) {
  const payload = await readJsonFileWithDefault(filePath, { entries: [] });

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} file must contain an object with an entries array: ${filePath}`);
  }

  if (!Array.isArray(payload.entries)) {
    throw new Error(`${label} file must contain an entries array: ${filePath}`);
  }

  return payload.entries.map((entry, index) => validateEmailPoolEntry(entry, index, filePath, label));
}

function normalizeXAuthPoolEntry(line, index, filePath, label) {
  const xAuthToken = normalizeBearerToken(line);
  if (!xAuthToken) {
    throw new Error(`${label} entry at line ${index + 1} is missing an X auth token in ${filePath}`);
  }

  return { xAuthToken };
}

async function loadXAuthPoolFile(filePath, label) {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = await readFile(filePath, 'utf8');
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => normalizeXAuthPoolEntry(line, index, filePath, label));
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeXAuthTokenForIdentity(value) {
  return normalizeBearerToken(value).toLowerCase();
}

function buildBlockedIdentitySets(identityRecords) {
  return {
    emails: new Set(
      identityRecords
        .map((entry) => normalizeEmail(entry?.email))
        .filter(Boolean),
    ),
    xAuthTokens: new Set(
      identityRecords
        .map((entry) => normalizeXAuthTokenForIdentity(entry?.xAuthToken))
        .filter(Boolean),
    ),
  };
}

function filterAvailableUniqueXAuthEntries(rawXAuthEntries, blockedXAuthTokenSet) {
  const seenXAuthTokenSet = new Set(blockedXAuthTokenSet);
  const availableEntries = [];

  for (const entry of rawXAuthEntries) {
    const normalizedXAuthToken = normalizeXAuthTokenForIdentity(entry?.xAuthToken);
    if (!normalizedXAuthToken || seenXAuthTokenSet.has(normalizedXAuthToken)) {
      continue;
    }

    seenXAuthTokenSet.add(normalizedXAuthToken);
    availableEntries.push(entry);
  }

  return availableEntries;
}

function isXSocialRecord(social) {
  const candidates = [
    social?.type,
    social?.provider,
    social?.platform,
    social?.name,
    social?.providerType,
    social?.accountType,
  ];

  return candidates.some((candidate) => {
    const normalized = String(candidate ?? '').trim().toLowerCase();
    return normalized === 'x' || normalized === 'twitter' || normalized === 'twitter_oauth' || normalized.includes('twitter');
  });
}

function hasXSocialConnection(mePayload) {
  const socials = Array.isArray(mePayload?.user?.socials) ? mePayload.user.socials : [];
  return socials.some(isXSocialRecord);
}

function getAuthMeSocials(mePayload) {
  return Array.isArray(mePayload?.user?.socials) ? mePayload.user.socials : [];
}

function findBlockedIdentityConflict(identitySelection, blockedSets) {
  const normalizedEmail = normalizeEmail(identitySelection?.email);
  if (normalizedEmail && blockedSets.emails.has(normalizedEmail)) {
    return `email ${identitySelection.email}`;
  }

  const normalizedXAuthToken = normalizeXAuthTokenForIdentity(identitySelection?.xAuthToken);
  if (normalizedXAuthToken && blockedSets.xAuthTokens.has(normalizedXAuthToken)) {
    return `X auth token for ${identitySelection?.email ?? 'selected identity'}`;
  }

  return '';
}

async function assertIdentitySelectionIsStillAvailable(identitySelection) {
  return withIdentityPoolLock(async () => {
    const usedIdentities = await readIdentityRecordFile(USED_IDENTITIES_PATH, 'Used identities');
    const refusedIdentities = await readIdentityRecordFile(REFUSED_IDENTITIES_PATH, 'Refused identities');
    const reservedIdentities = await readIdentityRecordFile(RESERVED_IDENTITIES_PATH, 'Reserved identities');
    const reservationId = String(identitySelection?.reservationId ?? '').trim();
    const normalizedEmail = normalizeEmail(identitySelection?.email);
    const otherReservedIdentities = reservedIdentities.filter((entry) => {
      if (reservationId && String(entry?.reservationId ?? '').trim() === reservationId) {
        return false;
      }

      return normalizeEmail(entry?.email) !== normalizedEmail;
    });
    const blockedSets = buildBlockedIdentitySets([
      ...usedIdentities,
      ...refusedIdentities,
      ...otherReservedIdentities,
    ]);
    const conflict = findBlockedIdentityConflict(identitySelection, blockedSets);

    if (conflict) {
      throw new Error(`Selected identity is no longer available because ${conflict} is already used, refused, or reserved.`);
    }
  });
}

function getSonjjMailboxConfig(email) {
  const normalizedEmail = normalizeEmail(email);
  const domain = normalizedEmail.split('@')[1] ?? '';
  const config = SONJJ_MAILBOX_CONFIG[domain];

  if (config) {
    return config;
  }

  throw new Error(`Unsupported SonJJ mailbox provider for ${email}. Expected an @outlook.com or @gmail.com address.`);
}

function createNameAllocator(values, reservedValues, { reverse = false } = {}) {
  const normalizedValues = values.map((value) => String(value ?? '').trim());
  const reservedSet = new Set(
    reservedValues.map((value) => String(value ?? '').trim()).filter(Boolean),
  );
  const blankTotal = normalizedValues.filter((value) => !value).length;
  const blankConsumedFromHistory = reservedValues
    .map((value) => String(value ?? '').trim())
    .filter((value) => !value).length;
  let blankConsumed = Math.min(blankTotal, blankConsumedFromHistory);
  let cursor = reverse ? normalizedValues.length - 1 : 0;

  const nonEmptyAvailableCount = normalizedValues.filter(
    (value) => value && !reservedSet.has(value),
  ).length;
  const blankAvailableCount = Math.max(0, blankTotal - blankConsumed);

  return {
    availableCount: nonEmptyAvailableCount + blankAvailableCount,

    pickNext() {
      while (cursor >= 0 && cursor < normalizedValues.length) {
        const candidate = normalizedValues[cursor];
        cursor += reverse ? -1 : 1;

        if (!candidate) {
          if (blankConsumed < blankTotal) {
            blankConsumed += 1;
            return '';
          }

          continue;
        }

        if (reservedSet.has(candidate)) {
          continue;
        }

        reservedSet.add(candidate);
        return candidate;
      }

      throw new Error('No unused name values remain in the identity pool.');
    },
  };
}

function createDescriptionAllocator(values, reservedValues, { reverse = false } = {}) {
  const normalizedValues = values.map((value) => String(value ?? '').trim());
  const reservedSet = new Set(
    reservedValues.map((value) => String(value ?? '').trim()).filter(Boolean),
  );
  const blankTotal = normalizedValues.filter((value) => !value).length;
  const blankConsumedFromHistory = reservedValues
    .map((value) => String(value ?? '').trim())
    .filter((value) => !value).length;
  let blankConsumed = Math.min(blankTotal, blankConsumedFromHistory);
  let cursor = reverse ? normalizedValues.length - 1 : 0;

  const nonEmptyAvailableCount = normalizedValues.filter(
    (value) => value && !reservedSet.has(value),
  ).length;
  const blankAvailableCount = Math.max(0, blankTotal - blankConsumed);

  return {
    availableCount: nonEmptyAvailableCount + blankAvailableCount,

    pickNext() {
      while (cursor >= 0 && cursor < normalizedValues.length) {
        const candidate = normalizedValues[cursor];
        cursor += reverse ? -1 : 1;

        if (!candidate) {
          if (blankConsumed < blankTotal) {
            blankConsumed += 1;
            return '';
          }

          continue;
        }

        if (reservedSet.has(candidate)) {
          continue;
        }

        reservedSet.add(candidate);
        return candidate;
      }

      throw new Error('No unused description values remain in the identity pool.');
    },
  };
}

async function resolveIdentitySelections({
  requestedNickname,
  requestedDescription,
  limit,
  emailPoolPath = MY_EMAIL_POOL_PATH,
  xAuthPoolPath = X_AUTH_POOL_PATH,
  fallbackXAuthEntry = null,
  identityOrder = 'forward',
}) {
  return withIdentityPoolLock(async () => {
    const requestedLimit = Number(limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error(`Limit must be a positive integer. Received: ${limit}`);
    }

    if (!['forward', 'reverse'].includes(identityOrder)) {
      throw new Error(`Identity order must be either "forward" or "reverse". Received: ${identityOrder}`);
    }

    const usedIdentities = await readIdentityRecordFile(USED_IDENTITIES_PATH, 'Used identities');
    const refusedIdentities = await readIdentityRecordFile(REFUSED_IDENTITIES_PATH, 'Refused identities');
    const reservedIdentities = await readIdentityRecordFile(RESERVED_IDENTITIES_PATH, 'Reserved identities');
    const names = await loadStringArrayFile(NAMES_POOL_PATH, 'Names pool', { keepEmpty: true });
    const descriptions = await loadStringArrayFile(DESCRIPTIONS_POOL_PATH, 'Descriptions pool', {
      keepEmpty: true,
    });
    const emailEntries = await loadEmailEntryPoolFile(emailPoolPath, 'My email pool');
    const loadedXAuthEntries = await loadXAuthPoolFile(xAuthPoolPath, 'X auth pool');
    const rawXAuthEntries = loadedXAuthEntries.length > 0
      ? loadedXAuthEntries
      : fallbackXAuthEntry
        ? Array.from({ length: requestedLimit }, () => fallbackXAuthEntry)
        : [];
    const blockedSets = buildBlockedIdentitySets([...usedIdentities, ...refusedIdentities, ...reservedIdentities]);
    const availableEmailEntries = emailEntries.filter(
      (entry) => !blockedSets.emails.has(normalizeEmail(entry.email)),
    );
    const xAuthEntries = filterAvailableUniqueXAuthEntries(rawXAuthEntries, blockedSets.xAuthTokens);
    const useReverseOrder = identityOrder === 'reverse';

    if (availableEmailEntries.length === 0) {
      throw new Error(`No unused email entries remain in ${emailPoolPath}`);
    }

    const orderedAvailableEmailEntries = useReverseOrder
      ? [...availableEmailEntries].reverse()
      : availableEmailEntries;
    const selectedEmailEntries = orderedAvailableEmailEntries.slice(0, requestedLimit);
    const explicitNickname = String(requestedNickname ?? '').trim();
    const explicitDescription = String(requestedDescription ?? '').trim();
    const reservedNicknames = [...usedIdentities, ...refusedIdentities, ...reservedIdentities].map(
      (entry) => entry?.nickname,
    );
    const reservedDescriptions = [...usedIdentities, ...refusedIdentities, ...reservedIdentities].map(
      (entry) => entry?.description,
    );
    const nicknameAllocator = explicitNickname
      ? null
      : createNameAllocator(names, reservedNicknames, { reverse: useReverseOrder });
    const descriptionAllocator = explicitDescription
      ? null
      : createDescriptionAllocator(descriptions, reservedDescriptions, { reverse: useReverseOrder });
    const maxSelectable = Math.min(
      orderedAvailableEmailEntries.length,
      xAuthEntries.length,
      explicitNickname ? Number.POSITIVE_INFINITY : nicknameAllocator.availableCount,
      explicitDescription ? Number.POSITIVE_INFINITY : descriptionAllocator.availableCount,
    );

    if (maxSelectable < 1) {
      if (!explicitDescription && descriptionAllocator.availableCount === 0) {
        throw new Error('No unused description values remain in the identity pool.');
      }

      if (!explicitNickname && nicknameAllocator.availableCount === 0) {
        throw new Error('No unused name values remain in the identity pool.');
      }

      throw new Error(`No unused email entries remain in ${emailPoolPath}`);
    }

    const selectedCount = Math.min(requestedLimit, maxSelectable);
    if (selectedCount < requestedLimit) {
      console.warn(
        `Requested limit ${requestedLimit} exceeds remaining identity capacity ${selectedCount}. ` +
          `Continuing with ${selectedCount} email(s).`,
      );
    }

    const orderedXAuthEntries = useReverseOrder ? [...xAuthEntries].reverse() : xAuthEntries;
    const selectedIdentities = selectedEmailEntries.slice(0, selectedCount).map((selectedEmailEntry, selectionIndex) => {
      const resolvedEmail = selectedEmailEntry.email;
      const existingIdentity = usedIdentities.find(
        (entry) => normalizeEmail(entry?.email) === normalizeEmail(resolvedEmail),
      );

      const resolvedNickname =
        explicitNickname ||
        String(existingIdentity?.nickname ?? '').trim() ||
        nicknameAllocator.pickNext();

      const resolvedDescription =
        explicitDescription ||
        String(existingIdentity?.description ?? '').trim() ||
        descriptionAllocator.pickNext();

      if (!explicitNickname) {
        reservedNicknames.push(resolvedNickname);
      }

      if (!explicitDescription) {
        reservedDescriptions.push(resolvedDescription);
      }

      const xAuthEntry = orderedXAuthEntries[selectionIndex];
      return {
        reservationId: crypto.randomUUID(),
        reservedAt: new Date().toISOString(),
        email: resolvedEmail,
        timestamp: selectedEmailEntry.timestamp,
        nickname: resolvedNickname,
        description: resolvedDescription,
        xAuthToken: xAuthEntry.xAuthToken,
      };
    });

    await writeJsonFile(RESERVED_IDENTITIES_PATH, [...reservedIdentities, ...selectedIdentities]);
    return selectedIdentities;
  });
}

function queueIdentityPoolWrite(task) {
  const queuedTask = identityPoolWriteQueue.then(task, task);
  identityPoolWriteQueue = queuedTask.catch(() => {});
  return queuedTask;
}

async function releaseReservedIdentity(record) {
  return queueIdentityPoolWrite(async () => {
    return withIdentityPoolLock(async () => {
      const reservedIdentities = await readIdentityRecordFile(RESERVED_IDENTITIES_PATH, 'Reserved identities');
      const normalizedEmail = normalizeEmail(record?.email);
      const reservationId = String(record?.reservationId ?? '').trim();
      const nextReservedIdentities = reservedIdentities.filter((entry) => {
        if (reservationId && String(entry?.reservationId ?? '').trim() === reservationId) {
          return false;
        }

        return normalizeEmail(entry?.email) !== normalizedEmail;
      });

      await writeJsonFile(RESERVED_IDENTITIES_PATH, nextReservedIdentities);
    });
  });
}

async function recordUsedIdentity(record) {
  return queueIdentityPoolWrite(async () => {
    return withIdentityPoolLock(async () => {
      const usedIdentities = await readIdentityRecordFile(USED_IDENTITIES_PATH, 'Used identities');
      const reservedIdentities = await readIdentityRecordFile(RESERVED_IDENTITIES_PATH, 'Reserved identities');
      const normalizedEmail = normalizeEmail(record?.email);
      const reservationId = String(record?.reservationId ?? '').trim();
      const { reservationId: omittedReservationId, ...storedRecord } = record ?? {};
      const nextUsedIdentities = usedIdentities.filter(
        (entry) => normalizeEmail(entry?.email) !== normalizedEmail,
      );
      const nextReservedIdentities = reservedIdentities.filter((entry) => {
        if (reservationId && String(entry?.reservationId ?? '').trim() === reservationId) {
          return false;
        }

        return normalizeEmail(entry?.email) !== normalizedEmail;
      });

      nextUsedIdentities.push(storedRecord);
      await writeJsonFile(USED_IDENTITIES_PATH, nextUsedIdentities);
      await writeJsonFile(RESERVED_IDENTITIES_PATH, nextReservedIdentities);
    });
  });
}

async function recordRefusedIdentity(record) {
  return queueIdentityPoolWrite(async () => {
    return withIdentityPoolLock(async () => {
      const refusedIdentities = await readIdentityRecordFile(REFUSED_IDENTITIES_PATH, 'Refused identities');
      const reservedIdentities = await readIdentityRecordFile(RESERVED_IDENTITIES_PATH, 'Reserved identities');
      const normalizedEmail = normalizeEmail(record?.email);
      const reservationId = String(record?.reservationId ?? '').trim();
      const { reservationId: omittedReservationId, ...storedRecord } = record ?? {};
      const nextRefusedIdentities = refusedIdentities.filter(
        (entry) => normalizeEmail(entry?.email) !== normalizedEmail,
      );
      const nextReservedIdentities = reservedIdentities.filter((entry) => {
        if (reservationId && String(entry?.reservationId ?? '').trim() === reservationId) {
          return false;
        }

        return normalizeEmail(entry?.email) !== normalizedEmail;
      });

      nextRefusedIdentities.push(storedRecord);
      await writeJsonFile(REFUSED_IDENTITIES_PATH, nextRefusedIdentities);
      await writeJsonFile(RESERVED_IDENTITIES_PATH, nextReservedIdentities);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIntegerBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function readSetting(args, envFile, argKey, envKey, fallbackValue) {
  return args[argKey] ?? process.env[envKey] ?? envFile[envKey] ?? fallbackValue;
}

function readIntegerSetting(args, envFile, { argKey, envKey, fallbackValue, label, min = null }) {
  const value = Number(readSetting(args, envFile, argKey, envKey, fallbackValue));

  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer. Received: ${value}`);
  }

  if (min !== null && value < min) {
    throw new Error(`${label} must be greater than or equal to ${min}. Received: ${value}`);
  }

  return value;
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
      entries[key.trim()] = rest.join('=').trim();
    }

    return entries;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function getSonjjApiKey(envFile) {
  return (
    process.env.SONJJ_API_KEY ||
    process.env.X_API_KEY ||
    envFile.SONJJ_API_KEY ||
    envFile.X_API_KEY ||
    envFile['X-Api-Key']
  );
}


async function fetchSonjjJson(apiKey, endpointPath, params) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const url = searchParams.size
    ? `${SONJJ_BASE_URL}${endpointPath}?${searchParams.toString()}`
    : `${SONJJ_BASE_URL}${endpointPath}`;

  const response = await executeFetchWithRetry(
    () =>
      fetch(url, {
        headers: {
          'X-Api-Key': apiKey,
          Accept: 'application/json',
        },
      }),
    `SonJJ request to ${endpointPath}`,
  );

  const text = await response.text();
  const data = tryParseJsonText(text);

  if (!response.ok) {
    const message = data?.error?.message || response.statusText || 'Request failed';
    throw new Error(`SonJJ request failed for ${endpointPath}: ${response.status} ${message}`);
  }

  return data;
}

function normalizeLower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseMessageDateMs(message) {
  const candidates = [
    message?.textDate,
    message?.date,
    message?.createdAt,
    message?.created_at,
    message?.receivedAt,
    message?.received_at,
  ];

  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate ?? ''));
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return Number.NEGATIVE_INFINITY;
}

function extractMessageArray(payload, depth = 0) {
  if (depth > 5 || payload === null || payload === undefined) {
    return null;
  }

  if (Array.isArray(payload)) {
    const looksLikeMessageArray = payload.every(
      (item) => item && typeof item === 'object' && ('mid' in item || 'textSubject' in item || 'textFrom' in item),
    );

    if (looksLikeMessageArray) {
      return payload;
    }

    for (const item of payload) {
      const nested = extractMessageArray(item, depth + 1);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  if (typeof payload !== 'object') {
    return null;
  }

  for (const key of MESSAGE_ARRAY_HINT_KEYS) {
    if (key in payload) {
      const nested = extractMessageArray(payload[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }

  for (const value of Object.values(payload)) {
    const nested = extractMessageArray(value, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findLatestMatchingOtpMessage(messages, otpRequestedAtMs) {
  const matchingMessages = messages
    .map((message, index) => ({
      index,
      message,
      dateMs: parseMessageDateMs(message),
      sender: normalizeLower(message?.textFrom),
      subject: String(message?.textSubject ?? '').trim(),
    }))
    .filter(({ sender, subject }) => {
      const senderMatches = EXPECTED_OTP_SENDERS.includes(sender);
      const subjectMatches = subject.toLowerCase() === EXPECTED_OTP_SUBJECT.toLowerCase();
      return senderMatches && subjectMatches;
    })
    .sort((left, right) => {
      if (right.dateMs !== left.dateMs) {
        return right.dateMs - left.dateMs;
      }

      return right.index - left.index;
    });

  if (matchingMessages.length === 0) {
    return {
      selectedMessage: null,
      matchingCount: 0,
      latestMessageDateMs: null,
    };
  }

  const selected = matchingMessages[0];
  const minimumFreshnessMs = otpRequestedAtMs - 60_000;
  const isFreshEnough = selected.dateMs === Number.NEGATIVE_INFINITY || selected.dateMs >= minimumFreshnessMs;

  return {
    selectedMessage: isFreshEnough ? selected.message : null,
    staleMessage: isFreshEnough ? null : selected.message,
    matchingCount: matchingMessages.length,
    latestMessageDateMs: Number.isFinite(selected.dateMs) ? selected.dateMs : null,
  };
}

async function pollForOtpMessage({ apiKey, email, timestamp, otpRequestedAtMs, waitMs, pollAttempts, inboxPath }) {
  if (waitMs > 0) {
    console.log(`Waiting ${waitMs}ms before polling SonJJ inbox ...`);
    await sleep(waitMs);
  }

  for (let attemptNumber = 1; attemptNumber <= pollAttempts; attemptNumber += 1) {
    const inboxPayload = await fetchSonjjJson(apiKey, inboxPath, {
      email,
      timestamp,
    });
    const messages = extractMessageArray(inboxPayload) ?? [];
    const selection = findLatestMatchingOtpMessage(messages, otpRequestedAtMs);

    if (selection.selectedMessage?.mid) {
      return selection.selectedMessage;
    }

    if (attemptNumber < pollAttempts) {
      console.log(`OTP not found yet in SonJJ inbox (attempt ${attemptNumber}/${pollAttempts}). Waiting ${waitMs}ms before retry ...`);
      await sleep(waitMs);
    }
  }

  throw new Error(`Unable to find a fresh Surge OTP email for ${email} after ${pollAttempts} inbox poll attempts.`);
}

function collectStrings(value, bucket, seen = new Set()) {
  if (typeof value === 'string') {
    bucket.push(value);
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, bucket, seen);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectStrings(item, bucket, seen);
  }
}

function extractOtpCode(messagePayload) {
  const textParts = [];
  collectStrings(messagePayload, textParts);

  const combinedText = textParts.join('\n');
  const patterns = [
    /(?:login code(?: for surge)?|verification code|one-time code|otp|code)\D{0,25}(\d{4,8})/i,
    /\b(\d{6})\b/,
    /\b(\d{4,8})\b/,
  ];

  for (const pattern of patterns) {
    const match = combinedText.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const preview = combinedText.slice(0, 2000);
  throw new Error(`Unable to extract OTP code from SonJJ message payload. Preview: ${preview}`);
}

async function requestOtp({ cookieJar, clientAnalyticsId, email, captchaToken }) {
  const initBody = { email };
  if (captchaToken) {
    initBody.token = captchaToken;
  }

  const otpInit = await fetchJsonWithCookies(cookieJar, `${PRIVY_BASE_URL}/api/v1/passwordless/init`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId),
    body: JSON.stringify(initBody),
  });

  if (!otpInit.ok) {
    throw new Error(`OTP init failed with ${otpInit.status}: ${JSON.stringify(otpInit.data)}`);
  }
}

async function validateInviteCode({ cookieJar, inviteCode }) {
  if (!inviteCode) {
    return;
  }

  await fetchJsonWithCookies(
    cookieJar,
    `${SURGE_BACKEND_URL}/invite/validate?code=${encodeURIComponent(inviteCode)}`,
    {
      method: 'GET',
      headers: buildSurgeHeaders(),
    },
  );

  await fetchJsonWithCookies(
    cookieJar,
    `${SURGE_BACKEND_URL}/auth/checkInviteCode?code=${encodeURIComponent(inviteCode)}`,
    {
      method: 'GET',
      headers: buildSurgeHeaders(),
    },
  );
}

async function fetchOtpCodeForEmail({ apiKey, email, timestamp, waitMs, pollAttempts, mailboxConfig }) {
  const otpRequestedAtMs = Date.now();
  const selectedMessage = await pollForOtpMessage({
    apiKey,
    email,
    timestamp,
    otpRequestedAtMs,
    waitMs,
    pollAttempts,
    inboxPath: mailboxConfig.inboxPath,
  });

  const sonjjMessage = await fetchSonjjJson(apiKey, mailboxConfig.messagePath, {
    email,
    mid: selectedMessage.mid,
  });
  const code = extractOtpCode(sonjjMessage);

  return {
    code,
    messageId: selectedMessage.mid,
  };
}

async function authenticatePrivySession({ cookieJar, clientAnalyticsId, email, code }) {
  const privyAuth = await fetchJsonWithCookies(cookieJar, `${PRIVY_BASE_URL}/api/v1/passwordless/authenticate`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId),
    body: JSON.stringify({
      email,
      code,
      mode: DEFAULT_MODE,
    }),
  });

  if (!privyAuth.ok) {
    throw new Error(`Privy authenticate failed with ${privyAuth.status}: ${JSON.stringify(privyAuth.data)}`);
  }

  return privyAuth.data;
}

async function exchangeBackendLogin({ cookieJar, tokenCandidates, inviteCode, logPrefix }) {
  let backendLogin = null;
  let backendLoginTokens = null;
  let backendLoginTokenSource = null;

  for (const candidate of tokenCandidates) {
    console.log(`${logPrefix}Trying Surge backend login with ${candidate.source} ...`);
    const loginBody = {
      type: 'PRIVY',
      code: candidate.value,
      ...(inviteCode ? { inviteCode } : {}),
    };
    const attempt = await fetchJsonWithCookies(cookieJar, `${SURGE_BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: buildSurgeHeaders(),
      body: JSON.stringify(loginBody),
    });
    const tokens = getBackendLoginTokens(attempt.data);

    if (attempt.ok && tokens) {
      backendLogin = attempt;
      backendLoginTokens = tokens;
      backendLoginTokenSource = candidate.source;
      break;
    }
  }

  return {
    backendLogin,
    backendLoginTokens,
    backendLoginTokenSource,
  };
}

async function updateProfile({ accessToken, nickname, description }) {
  if (nickname) {
    await fetchAuthedJson(accessToken, '/users/my-nickname', {
      method: 'POST',
      body: { nickname },
    });
  }

  if (description) {
    await fetchAuthedJson(accessToken, '/users/my-description', {
      method: 'POST',
      body: { description },
    });
  }
}

async function getCurrentProjectIgnites(accessToken, resolvedProjectId) {
  const leaderboardMe = await fetchAuthedJson(accessToken, '/leaderboard/me');
  const topProjects = Array.isArray(leaderboardMe?.topProjects) ? leaderboardMe.topProjects : [];
  const project = topProjects.find((entry) => String(entry?.projectId ?? '') === String(resolvedProjectId));
  return Math.max(0, Number(project?.ignites ?? 0));
}

async function allocateProjectIgnites({ accessToken, resolvedProjectId, allocationAmount }) {
  const currentProjectIgnites = await getCurrentProjectIgnites(accessToken, resolvedProjectId).catch(() => 0);
  const personalCapacityBefore = await fetchAuthedJson(accessToken, '/ignites/capacity');
  const availableCapacity = Math.max(0, Number(personalCapacityBefore?.available ?? 0));
  const requestedAmount = allocationAmount === 'max'
    ? Math.max(0, Math.min(DEFAULT_MAX_PROJECT_IGNITES - currentProjectIgnites, availableCapacity))
    : Number(allocationAmount);

  if (!Number.isInteger(requestedAmount) || requestedAmount < 0) {
    throw new Error(`Allocation amount must be a positive integer or "max". Received: ${allocationAmount}`);
  }

  if (requestedAmount === 0) {
    return {
      allocationStatus: currentProjectIgnites > 0 ? 'already-allocated' : 'no-capacity',
      allocatedAmount: currentProjectIgnites,
      newlyAllocatedAmount: 0,
      requestedAmount,
      currentProjectIgnites,
      finalProjectIgnites: currentProjectIgnites,
      personalCapacity: personalCapacityBefore,
    };
  }

  let hasFreshAllocation = false;
  let allocationStatus = null;
  let allocationResult = null;

  try {
    allocationResult = await fetchAuthedJson(accessToken, '/ignites/allocate', {
      method: 'POST',
      body: {
        projectId: resolvedProjectId,
        amount: requestedAmount,
      },
    });
    hasFreshAllocation = true;
    allocationStatus = 'allocated';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('403: Insufficient available capacity')) {
      throw error;
    }

    allocationStatus = 'insufficient-capacity';
  }

  const personalCapacity = await fetchAuthedJson(accessToken, '/ignites/capacity');

  if (!hasFreshAllocation && allocationStatus === 'insufficient-capacity') {
    const existingAllocations = findProjectAllocations(personalCapacity, resolvedProjectId);
    const matchedAllocation = existingAllocations.find(
      (entry) => Number(entry?.amount ?? 0) >= requestedAmount,
    );

    if (matchedAllocation) {
      allocationStatus = 'already-allocated';
    }
  }

  const finalProjectIgnites = await getCurrentProjectIgnites(accessToken, resolvedProjectId).catch(() => currentProjectIgnites);
  if (finalProjectIgnites > currentProjectIgnites && allocationStatus !== 'allocated') {
    allocationStatus = 'allocated';
  }

  return {
    allocationStatus,
    allocatedAmount: finalProjectIgnites,
    newlyAllocatedAmount: Math.max(0, finalProjectIgnites - currentProjectIgnites),
    requestedAmount,
    currentProjectIgnites,
    finalProjectIgnites,
    allocationResult,
    personalCapacity,
  };
}

function logAllocationOutcome({ logPrefix, resolvedEmail, allocationStatus, allocatedAmount }) {
  if (allocationStatus === 'already-allocated') {
    console.log(`${logPrefix}Login completed and the requested ignites were already allocated for ${resolvedEmail}.`);
    return;
  }

  if (allocationStatus === 'allocated') {
    console.log(`${logPrefix}Login completed and ${allocatedAmount ?? 'requested'} ignites allocated for ${resolvedEmail}.`);
    return;
  }

  if (allocationStatus === 'insufficient-capacity') {
    console.log(`${logPrefix}Login completed but ignites could not be allocated for ${resolvedEmail} due to insufficient capacity.`);
    return;
  }

  if (allocationStatus === 'no-capacity') {
    console.log(`${logPrefix}Login completed for ${resolvedEmail}, but there is no available ignite capacity to allocate.`);
    return;
  }

  console.log(`${logPrefix}Login completed for ${resolvedEmail}.`);
}

async function runSingleLoginSession({
  inviteCode,
  resolvedProjectId,
  allocationAmount,
  captchaToken,
  otpWaitMs,
  otpPollAttempts,
  sonjjApiKey,
  identitySelection,
  batchIndex,
  batchTotal,
  xAuthToken,
}) {
  const resolvedEmail = String(identitySelection.email ?? '').trim();
  const reservationId = String(identitySelection.reservationId ?? '').trim();
  const resolvedNickname = String(identitySelection.nickname ?? '').trim();
  const resolvedDescription = String(identitySelection.description ?? '').trim();
  const sessionXAuthToken = identitySelection.xAuthToken || xAuthToken;
  const mailboxTimestamp = String(identitySelection.timestamp ?? '').trim();
  const logPrefix = batchTotal > 1 ? `[${batchIndex + 1}/${batchTotal}] ` : '';
  const mailboxConfig = getSonjjMailboxConfig(resolvedEmail);

  if (!resolvedEmail) {
    throw new Error(`Email is required from ${MY_EMAIL_POOL_PATH}.`);
  }

  if (!isNumericString(mailboxTimestamp)) {
    throw new Error(`Mailbox timestamp is required from ${MY_EMAIL_POOL_PATH} for ${resolvedEmail}.`);
  }

  await assertIdentitySelectionIsStillAvailable(identitySelection);

  console.log(`${logPrefix}Sending OTP to ${resolvedEmail} using SonJJ ${mailboxConfig.provider} mailbox ...`);

  const clientAnalyticsId = crypto.randomUUID();
  const cookieJar = createCookieJar();

  await requestOtp({
    cookieJar,
    clientAnalyticsId,
    email: resolvedEmail,
    captchaToken,
  });
  await validateInviteCode({ cookieJar, inviteCode });

  let code;
  let messageId;

  try {
    ({ code, messageId } = await fetchOtpCodeForEmail({
      apiKey: sonjjApiKey,
      email: resolvedEmail,
      timestamp: mailboxTimestamp,
      waitMs: otpWaitMs,
      pollAttempts: otpPollAttempts,
      mailboxConfig,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRefusedIdentity({
      reservationId,
      email: resolvedEmail,
      nickname: resolvedNickname,
      description: resolvedDescription,
      reason: 'otp-failed',
      refusedAt: new Date().toISOString(),
      error: message,
    });

    console.log(`${logPrefix}OTP failed for ${resolvedEmail}. Added to refused list.`);

    if (batchIndex < batchTotal - 1) {
      console.log(`${logPrefix}Completed ${resolvedEmail}. Proceeding to next email ...`);
    } else {
      console.log(`${logPrefix}Completed ${resolvedEmail}. All emails ended.`);
    }

    return {
      email: resolvedEmail,
      allocationStatus: 'refused',
    };
  }

  console.log(`${logPrefix}Using OTP from SonJJ message ${messageId} ...`);
  console.log(`${logPrefix}Authenticating with Privy ...`);

  const privyAuthData = await authenticatePrivySession({
    cookieJar,
    clientAnalyticsId,
    email: resolvedEmail,
    code,
  });

  const tokenCandidates = buildAuthTokenCandidates(privyAuthData);
  if (tokenCandidates.length === 0) {
    throw new Error('Privy authenticate succeeded but no usable auth tokens were returned.');
  }

  const { backendLogin, backendLoginTokens, backendLoginTokenSource } = await exchangeBackendLogin({
    cookieJar,
    tokenCandidates,
    inviteCode,
    logPrefix,
  });

  if (!backendLoginTokens?.accessToken) {
    throw new Error(`Privy OTP login succeeded, but Surge backend token exchange did not complete for ${resolvedEmail}.`);
  }

  await updateProfile({
    accessToken: backendLoginTokens.accessToken,
    nickname: resolvedNickname,
    description: resolvedDescription,
  });

  const xLinked = await connectXAccountWithPrivyOAuthLink({
    cookieJar,
    clientAnalyticsId,
    accessToken: backendLoginTokens.accessToken,
    privyAccessToken: privyAuthData.token,
    xAuthToken: sessionXAuthToken,
    logPrefix,
  });

  if (sessionXAuthToken && !xLinked) {
    throw new Error(`X auth link did not appear in Surge /auth/me socials for ${resolvedEmail}.`);
  }
 
  const { allocationStatus, allocatedAmount, newlyAllocatedAmount, finalProjectIgnites } = await allocateProjectIgnites({
    accessToken: backendLoginTokens.accessToken,
    resolvedProjectId,
    allocationAmount,
  });

  await recordUsedIdentity({
    reservationId,
    email: resolvedEmail,
    nickname: resolvedNickname,
    description: resolvedDescription,
    xAuthToken: sessionXAuthToken,
    allocationStatus,
    allocatedAmount,
    newlyAllocatedAmount,
    finalProjectIgnites,
    usedAt: new Date().toISOString(),
  });

  logAllocationOutcome({
    logPrefix,
    resolvedEmail,
    allocationStatus,
    allocatedAmount: newlyAllocatedAmount || allocatedAmount,
  });

  if (batchIndex < batchTotal - 1) {
    console.log(`${logPrefix}Completed ${resolvedEmail}. Proceeding to next email ...`);
  } else {
    console.log(`${logPrefix}Completed ${resolvedEmail}. All emails ended.`);
  }

  return {
    email: resolvedEmail,
    allocationStatus,
    allocatedAmount,
    newlyAllocatedAmount,
    finalProjectIgnites,
  };
}

function classifyFailureReason(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('cannot_link_more_of_type') || text.includes('already has an account of that type linked')) {
    return 'x-already-linked';
  }

  if (text.includes('privy x oauth') || text.includes('x oauth') || text.includes('x auth') || text.includes('twitter')) {
    return 'x-link-failed';
  }

  if (text.includes('otp') || text.includes('sonjj') || text.includes('passwordless')) {
    return 'otp-failed';
  }

  if (text.includes('privy') || text.includes('/auth/login') || text.includes('backend token exchange')) {
    return 'login-failed';
  }

  return 'run-failed';
}

function createBatchSuccessResult(batchIndex, email, allocationStatus) {
  const isRefused = allocationStatus === 'refused';

  return {
    batchIndex: batchIndex + 1,
    email,
    ok: !isRefused,
    allocationStatus,
    ...(isRefused ? { error: 'otp-refused' } : {}),
  };
}

function createBatchFailureResult(batchIndex, email, error) {
  return {
    batchIndex: batchIndex + 1,
    email,
    ok: false,
    error,
  };
}

function loadRuntimeConfig(args, envFile) {
  const inviteCode = readSetting(args, envFile, 'invite', 'SURGE_INVITE_CODE', '');
  const requestedNickname = readSetting(args, envFile, 'nickname', 'SURGE_PROFILE_NICKNAME', '');
  const requestedDescription = readSetting(args, envFile, 'description', 'SURGE_PROFILE_DESCRIPTION', '');
  const resolvedProjectId = String(
    readSetting(args, envFile, 'project-id', 'SURGE_PROJECT_ID', DEFAULT_PROJECT_ID) ?? '',
  ).trim();
  const rawEmailPoolPath = String(
    readSetting(args, envFile, 'email-pool-file', 'SURGE_EMAIL_POOL_FILE', MY_EMAIL_POOL_PATH) ??
      MY_EMAIL_POOL_PATH,
  ).trim();
  const rawXAuthPoolPath = String(
    readSetting(args, envFile, 'you-auth-pool-file', 'SURGE_X_AUTH_POOL_FILE', X_AUTH_POOL_PATH) ?? X_AUTH_POOL_PATH,
  ).trim();
  const identityOrder = String(
    readSetting(args, envFile, 'identity-order', 'SURGE_IDENTITY_ORDER', 'forward') ?? 'forward',
  ).trim().toLowerCase();
  const rawAllocationAmount = String(readSetting(args, envFile, 'amount', 'SURGE_PROJECT_IGNITES', DEFAULT_PROJECT_IGNITES) ?? '').trim().toLowerCase();
  const allocationAmount = rawAllocationAmount === 'max'
    ? 'max'
    : readIntegerSetting(args, envFile, {
        argKey: 'amount',
        envKey: 'SURGE_PROJECT_IGNITES',
        fallbackValue: DEFAULT_PROJECT_IGNITES,
        label: 'Allocation amount',
        min: 1,
      });
  const captchaToken = readSetting(args, envFile, 'captcha-token', 'SURGE_CAPTCHA_TOKEN', undefined);
  const otpWaitMs = readIntegerSetting(args, envFile, {
    argKey: 'otp-wait-ms',
    envKey: 'SURGE_OTP_WAIT_MS',
    fallbackValue: DEFAULT_OTP_WAIT_MS,
    label: 'OTP wait duration',
    min: 0,
  });
  const otpPollAttempts = readIntegerSetting(args, envFile, {
    argKey: 'otp-poll-attempts',
    envKey: 'SURGE_OTP_POLL_ATTEMPTS',
    fallbackValue: DEFAULT_OTP_POLL_ATTEMPTS,
    label: 'OTP poll attempts',
    min: 1,
  });
  const requestedLimit = readIntegerSetting(args, envFile, {
    argKey: 'limit',
    envKey: 'SURGE_EMAIL_LIMIT',
    fallbackValue: DEFAULT_EMAIL_LIMIT,
    label: 'Limit',
    min: 1,
  });
  const batchDelayMinMs = readIntegerSetting(args, envFile, {
    argKey: 'batch-delay-min-ms',
    envKey: 'SURGE_BATCH_DELAY_MIN_MS',
    fallbackValue: DEFAULT_BATCH_DELAY_MIN_MS,
    label: 'Batch delay min',
    min: 0,
  });
  const batchDelayMaxMs = readIntegerSetting(args, envFile, {
    argKey: 'batch-delay-max-ms',
    envKey: 'SURGE_BATCH_DELAY_MAX_MS',
    fallbackValue: DEFAULT_BATCH_DELAY_MAX_MS,
    label: 'Batch delay max',
    min: 0,
  });
  const rawX = readSetting(args, envFile, 'x-token', 'X_AUTH_TOKEN', readSetting(args, envFile, 'x-auth', 'x-auth', ''));
  const xAuthToken = normalizeBearerToken(rawX);
 
  if (!resolvedProjectId) {
    throw new Error('Project id is required. Pass --project-id or set SURGE_PROJECT_ID.');
  }

  if (!rawEmailPoolPath) {
    throw new Error('Email pool file is required. Pass --email-pool-file or set SURGE_EMAIL_POOL_FILE.');
  }

  if (!['forward', 'reverse'].includes(identityOrder)) {
    throw new Error(`Identity order must be either "forward" or "reverse". Received: ${identityOrder}`);
  }

  if (batchDelayMaxMs < batchDelayMinMs) {
    throw new Error(`Batch delay max must be greater than or equal to batch delay min. Received: min=${batchDelayMinMs}, max=${batchDelayMaxMs}`);
  }

  return {
    inviteCode,
    requestedNickname,
    requestedDescription,
    resolvedProjectId,
    emailPoolPath: path.isAbsolute(rawEmailPoolPath)
      ? rawEmailPoolPath
      : path.resolve(projectRoot, rawEmailPoolPath),
    xAuthPoolPath: path.isAbsolute(rawXAuthPoolPath)
      ? rawXAuthPoolPath
      : path.resolve(projectRoot, rawXAuthPoolPath),
    identityOrder,
    allocationAmount,
    captchaToken,
    otpWaitMs,
    otpPollAttempts,
    requestedLimit,
    batchDelayMinMs,
    batchDelayMaxMs,
    xAuthToken,
    fallbackXAuthEntry: xAuthToken ? { xAuthToken } : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = await loadEnvFile();
  const sonjjApiKey = getSonjjApiKey(envFile);

  if (!sonjjApiKey) {
    throw new Error('Missing SonJJ API key. Add SONJJ_API_KEY, X_API_KEY, or X-Api-Key to .env or environment variables.');
  }

  const runtimeConfig = loadRuntimeConfig(args, envFile);
  const {
    inviteCode,
    requestedNickname,
    requestedDescription,
    resolvedProjectId,
    emailPoolPath,
    xAuthPoolPath,
    identityOrder,
    allocationAmount,
    captchaToken,
    otpWaitMs,
    otpPollAttempts,
    requestedLimit,
    batchDelayMinMs,
    batchDelayMaxMs,
    xAuthToken,
    fallbackXAuthEntry,
  } = runtimeConfig;

  const identitySelections = await resolveIdentitySelections({
    requestedNickname,
    requestedDescription,
    limit: requestedLimit,
    emailPoolPath,
    xAuthPoolPath,
    fallbackXAuthEntry,
    identityOrder,
  });
  const batchResults = [];
  const batchTotal = identitySelections.length;
  for (let batchIndex = 0; batchIndex < batchTotal; batchIndex += 1) {
    const identitySelection = identitySelections[batchIndex];

    try {
      const result = await runSingleLoginSession({
        inviteCode,
        resolvedProjectId,
        allocationAmount,
        captchaToken,
        otpWaitMs,
        otpPollAttempts,
        sonjjApiKey,
        identitySelection,
        batchIndex,
        batchTotal,
        xAuthToken,
      });

      batchResults.push(
        createBatchSuccessResult(batchIndex, identitySelection.email, result.allocationStatus),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const failureReason = classifyFailureReason(message);
      const shouldConsumeXToken = failureReason === 'x-already-linked' || failureReason === 'x-link-failed';
      const { xAuthToken: _failedXAuthToken, ...identityWithoutX } = identitySelection;
      await recordRefusedIdentity({
        ...identityWithoutX,
        ...(shouldConsumeXToken ? { xAuthToken: _failedXAuthToken } : {}),
        reason: failureReason,
        refusedAt: new Date().toISOString(),
        error: message,
      });
      batchResults.push(createBatchFailureResult(batchIndex, identitySelection.email, message));

      if (message !== 'otp-refused') {
        console.error(`[${batchIndex + 1}/${batchTotal}] ${message}`);
      }
    }

    if (batchIndex < batchTotal - 1) {
      const interEmailDelayMs = randomIntegerBetween(batchDelayMinMs, batchDelayMaxMs);
      console.log(`Waiting ${interEmailDelayMs}ms before starting next email ...`);
      await sleep(interEmailDelayMs);
    }
  }

  if (batchTotal <= 1) {
    const singleResult = batchResults[0] ?? null;
    if (singleResult && !singleResult.ok) {
      throw new Error(singleResult.error || `Run failed for ${singleResult.email}.`);
    }
    return;
  }

  const successCount = batchResults.filter((result) => result.ok).length;
  const failureCount = batchResults.length - successCount;

  console.log(`Batch completed. Success: ${successCount}. Failed: ${failureCount}.`);

  if (failureCount > 0) {
    throw new Error(`Completed batch with ${failureCount} failure(s).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
