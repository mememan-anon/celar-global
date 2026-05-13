import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');

const SURGE_APP_ORIGIN = 'https://app.surge.xyz';
const SURGE_BACKEND_URL = 'https://back.surge.xyz';
const PRIVY_BASE_URL = 'https://auth.privy.io';
const PRIVY_APP_ID = 'cmheubr2q0175h20c1a8xcg3l';
const SONJJ_BASE_URL = 'https://app.sonjj.com';
const DEFAULT_PROJECT_ID = '28';
const DEFAULT_AMOUNT = 'max';
const DEFAULT_MAX_AMOUNT = 15;
const DEFAULT_OTP_WAIT_MS = 10000;
const DEFAULT_OTP_ATTEMPTS = 4;
const EXPECTED_OTP_SENDERS = ['no-reply@privy.io', 'no-reply@mail.privy.io'];
const EXPECTED_OTP_SUBJECT = 'Your login code for Surge';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripWrappingQuotes(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

async function loadEnvFile() {
  const raw = await readFile(envPath, 'utf8').catch(() => '');
  const entries = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    entries[key.trim()] = stripWrappingQuotes(rest.join('='));
  }
  return entries;
}

function readSetting(args, envFile, argKey, envKey, fallbackValue) {
  return args[argKey] ?? process.env[envKey] ?? envFile[envKey] ?? fallbackValue;
}

function getSonjjApiKey(envFile) {
  return process.env.SONJJ_API_KEY || process.env.X_API_KEY || envFile.SONJJ_API_KEY || envFile.X_API_KEY || envFile['X-Api-Key'];
}

function tryParseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: tryParseJsonText(text),
  };
}

async function fetchRequiredJson(url, options = {}, label = url) {
  const response = await requestJson(url, options);
  if (!response.ok) {
    const message = response.data?.message || response.data?.error || response.statusText || 'Request failed';
    throw new Error(`${label} failed with ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
  return response.data;
}

function buildPrivyHeaders(clientAnalyticsId) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SURGE_APP_ORIGIN,
    Referer: `${SURGE_APP_ORIGIN}/`,
    'privy-app-id': PRIVY_APP_ID,
    'privy-ca-id': clientAnalyticsId,
    'privy-client': 'react-auth:2.25.0',
  };
}

async function fetchSonjjJson(apiKey, endpointPath, params) {
  const searchParams = new URLSearchParams(params);
  return fetchRequiredJson(`${SONJJ_BASE_URL}${endpointPath}?${searchParams.toString()}`, {
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
    },
  }, `SonJJ ${endpointPath}`);
}

function extractMessageArray(payload, depth = 0) {
  if (depth > 5 || payload === null || payload === undefined) return null;
  if (Array.isArray(payload)) {
    if (payload.every((item) => item && typeof item === 'object' && ('mid' in item || 'textSubject' in item || 'textFrom' in item))) return payload;
    for (const item of payload) {
      const nested = extractMessageArray(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;
  for (const key of ['data', 'messages', 'items', 'results', 'value']) {
    if (key in payload) {
      const nested = extractMessageArray(payload[key], depth + 1);
      if (nested) return nested;
    }
  }
  for (const value of Object.values(payload)) {
    const nested = extractMessageArray(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function parseMessageDateMs(message) {
  for (const candidate of [message?.textDate, message?.date, message?.createdAt, message?.created_at, message?.receivedAt, message?.received_at]) {
    const parsed = Date.parse(String(candidate ?? ''));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function findLatestOtpMessage(messages) {
  return messages
    .map((message, index) => ({
      index,
      message,
      dateMs: parseMessageDateMs(message),
      sender: String(message?.textFrom ?? '').trim().toLowerCase(),
      subject: String(message?.textSubject ?? '').trim(),
    }))
    .filter(({ sender, subject }) => EXPECTED_OTP_SENDERS.includes(sender) && subject.toLowerCase() === EXPECTED_OTP_SUBJECT.toLowerCase())
    .sort((left, right) => (right.dateMs - left.dateMs) || (right.index - left.index))[0]?.message ?? null;
}

function collectStrings(value, bucket, seen = new Set()) {
  if (typeof value === 'string') {
    bucket.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) collectStrings(item, bucket, seen);
}

function extractOtpCode(messagePayload) {
  const textParts = [];
  collectStrings(messagePayload, textParts);
  const combinedText = textParts.join('\n');
  for (const pattern of [/(?:login code(?: for surge)?|verification code|one-time code|otp|code)\D{0,25}(\d{4,8})/i, /\b(\d{6})\b/, /\b(\d{4,8})\b/]) {
    const match = combinedText.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new Error(`Unable to extract OTP code from message payload. Preview: ${combinedText.slice(0, 1000)}`);
}

async function fetchOtpCode({ apiKey, email, timestamp, waitMs, attempts, inboxPath, messagePath }) {
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    await sleep(waitMs);
    const inboxPayload = await fetchSonjjJson(apiKey, inboxPath, { email, timestamp });
    const selectedMessage = findLatestOtpMessage(extractMessageArray(inboxPayload) ?? []);
    if (selectedMessage?.mid) {
      const messagePayload = await fetchSonjjJson(apiKey, messagePath, { email, mid: selectedMessage.mid });
      return { code: extractOtpCode(messagePayload), messageId: selectedMessage.mid };
    }
    console.log(`OTP not found yet in SonJJ inbox (attempt ${attemptNumber}/${attempts}).`);
  }
  throw new Error(`Unable to find Surge OTP email for ${email}.`);
}

function getMailboxPaths(email) {
  const domain = String(email).trim().toLowerCase().split('@')[1] ?? '';
  if (domain === 'gmail.com') {
    return { inboxPath: '/v1/temp_gmail/inbox', messagePath: '/v1/temp_gmail/message' };
  }
  if (domain === 'outlook.com') {
    return { inboxPath: '/v1/temp_outlook/inbox', messagePath: '/v1/temp_outlook/message' };
  }
  throw new Error(`Unsupported mailbox domain for ${email}.`);
}

function buildAuthTokenCandidates(authResponse) {
  const seen = new Set();
  return [
    { source: 'token', value: authResponse?.token },
    { source: 'privy_access_token', value: authResponse?.privy_access_token },
    { source: 'identity_token', value: authResponse?.identity_token },
  ].filter(({ value }) => {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getBackendLoginTokens(payload) {
  const candidate = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (typeof candidate?.accessToken !== 'string' || typeof candidate?.refreshToken !== 'string') return null;
  return { accessToken: candidate.accessToken, refreshToken: candidate.refreshToken };
}

async function loginWithEmailOtp({ sonjjApiKey, email, timestamp, waitMs, attempts }) {
  const clientAnalyticsId = crypto.randomUUID();
  const mailbox = getMailboxPaths(email);

  console.log(`Sending login OTP to ${email} ...`);
  await fetchRequiredJson(`${PRIVY_BASE_URL}/api/v1/passwordless/init`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId),
    body: JSON.stringify({ email }),
  }, 'Privy OTP init');

  const { code, messageId } = await fetchOtpCode({
    apiKey: sonjjApiKey,
    email,
    timestamp,
    waitMs,
    attempts,
    ...mailbox,
  });
  console.log(`Using OTP from SonJJ message ${messageId} ...`);

  const privyAuth = await fetchRequiredJson(`${PRIVY_BASE_URL}/api/v1/passwordless/authenticate`, {
    method: 'POST',
    headers: buildPrivyHeaders(clientAnalyticsId),
    body: JSON.stringify({ email, code, mode: 'login-or-sign-up' }),
  }, 'Privy authenticate');

  for (const candidate of buildAuthTokenCandidates(privyAuth)) {
    console.log(`Trying Surge backend login with ${candidate.source} ...`);
    const login = await requestJson(`${SURGE_BACKEND_URL}/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: SURGE_APP_ORIGIN,
        Referer: `${SURGE_APP_ORIGIN}/`,
      },
      body: JSON.stringify({ type: 'PRIVY', code: candidate.value }),
    });
    const tokens = getBackendLoginTokens(login.data);
    if (login.ok && tokens) {
      return { ...tokens, tokenSource: candidate.source };
    }
  }

  throw new Error('Privy login succeeded, but Surge backend /auth/login did not return tokens.');
}

async function getCurrentProjectIgnites(accessToken, projectId) {
  const leaderboardMe = await fetchRequiredJson(`${SURGE_BACKEND_URL}/leaderboard/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, '/leaderboard/me');
  const topProjects = Array.isArray(leaderboardMe?.topProjects) ? leaderboardMe.topProjects : [];
  const project = topProjects.find((entry) => String(entry?.projectId ?? '') === String(projectId));
  return Math.max(0, Number(project?.ignites ?? 0));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = await loadEnvFile();
  const sonjjApiKey = getSonjjApiKey(envFile);
  if (!sonjjApiKey) throw new Error('Missing SonJJ API key.');

  const email = String(readSetting(args, envFile, 'email', 'SURGE_LOGIN_EMAIL', '') ?? '').trim();
  const timestamp = String(readSetting(args, envFile, 'timestamp', 'SURGE_LOGIN_EMAIL_TIMESTAMP', '') ?? '').trim();
  const projectId = String(readSetting(args, envFile, 'project-id', 'SURGE_PROJECT_ID', DEFAULT_PROJECT_ID) ?? '').trim();
  const rawAmount = String(readSetting(args, envFile, 'amount', 'SURGE_PROJECT_IGNITES', DEFAULT_AMOUNT) ?? '').trim().toLowerCase();
  const waitMs = Number(readSetting(args, envFile, 'otp-wait-ms', 'SURGE_OTP_WAIT_MS', DEFAULT_OTP_WAIT_MS));
  const attempts = Number(readSetting(args, envFile, 'otp-poll-attempts', 'SURGE_OTP_POLL_ATTEMPTS', DEFAULT_OTP_ATTEMPTS));

  if (!email) throw new Error('Email is required. Pass --email or set SURGE_LOGIN_EMAIL.');
  if (!/^\d+$/.test(timestamp)) throw new Error('Numeric timestamp is required. Pass --timestamp or set SURGE_LOGIN_EMAIL_TIMESTAMP.');
  if (!projectId) throw new Error('Project id is required. Pass --project-id or set SURGE_PROJECT_ID.');
  if (!Number.isInteger(waitMs) || waitMs < 0) throw new Error(`OTP wait ms must be a non-negative integer. Received: ${waitMs}`);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`OTP attempts must be a positive integer. Received: ${attempts}`);

  const tokens = await loginWithEmailOtp({ sonjjApiKey, email, timestamp, waitMs, attempts });
  const authHeaders = { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' };
  const [authMe, personalCapacityBefore] = await Promise.all([
    fetchRequiredJson(`${SURGE_BACKEND_URL}/auth/me`, { headers: authHeaders }, '/auth/me'),
    fetchRequiredJson(`${SURGE_BACKEND_URL}/ignites/capacity`, { headers: authHeaders }, '/ignites/capacity'),
  ]);
  const currentProjectIgnites = await getCurrentProjectIgnites(tokens.accessToken, projectId).catch(() => 0);
  const personalAvailable = Math.max(0, Number(personalCapacityBefore?.available ?? 0));
  const requestedAmount = rawAmount === 'max'
    ? Math.max(0, Math.min(DEFAULT_MAX_AMOUNT - currentProjectIgnites, personalAvailable))
    : Number(rawAmount);

  if (!Number.isInteger(requestedAmount) || requestedAmount < 0) {
    throw new Error(`Amount must be a positive integer or max. Received: ${rawAmount}`);
  }

  let allocation = null;
  let allocationStatus = requestedAmount > 0 ? 'pending' : 'no-capacity';
  if (requestedAmount > 0) {
    allocation = await fetchRequiredJson(`${SURGE_BACKEND_URL}/ignites/allocate`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, amount: requestedAmount }),
    }, '/ignites/allocate');
    allocationStatus = 'allocated';
  }

  const personalCapacityAfter = await fetchRequiredJson(`${SURGE_BACKEND_URL}/ignites/capacity`, {
    headers: authHeaders,
  }, '/ignites/capacity after allocation');
  const finalProjectIgnites = await getCurrentProjectIgnites(tokens.accessToken, projectId).catch(() => currentProjectIgnites);

  console.log(JSON.stringify({
    email,
    projectId,
    tokenSource: tokens.tokenSource,
    user: authMe?.user ?? authMe,
    currentProjectIgnites,
    requestedAmount,
    allocationStatus,
    allocation,
    finalProjectIgnites,
    newlyAllocatedAmount: Math.max(0, finalProjectIgnites - currentProjectIgnites),
    personalCapacityBefore,
    personalCapacityAfter,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
