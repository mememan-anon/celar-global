import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const DEFAULT_MODE = 'login-or-sign-up';
const SONJJ_BASE_URL = 'https://app.sonjj.com';
const DEFAULT_PROJECT_ID = '28';
const DEFAULT_PROJECT_IGNITES = 10; //dont touch at all
const DEFAULT_EMAIL_LIMIT =  2100;
const DEFAULT_BATCH_DELAY_MIN_MS = 5000;   // 5 seconds
const DEFAULT_BATCH_DELAY_MAX_MS = 30000;  // 30 seconds
const DEFAULT_OTP_WAIT_MS = 10000;
const DEFAULT_OTP_POLL_ATTEMPTS = 2;
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
const REFUSED_IDENTITIES_PATH = path.join(IDENTITY_POOL_DIR, 'refused-identities.json');
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

function buildPrivyHeaders(clientAnalyticsId) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SURGE_APP_ORIGIN,
    Referer: `${SURGE_APP_ORIGIN}/`,
    'privy-app-id': PRIVY_APP_ID,
    'privy-ca-id': clientAnalyticsId,
    'privy-client': 'surge-headless-script/1.0',
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

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
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

function pickFirstUnusedValue(values, usedValues, label) {
  const usedSet = new Set(usedValues.map((value) => String(value ?? '').trim()).filter(Boolean));
  const match = values.find((value) => !usedSet.has(String(value ?? '').trim()));

  if (!match) {
    throw new Error(`No unused ${label} values remain in the identity pool.`);
  }

  return match;
}

function listUnusedValues(values, reservedValues) {
  const reservedSet = new Set(
    reservedValues.map((value) => String(value ?? '').trim()).filter(Boolean),
  );

  return values.filter((value) => !reservedSet.has(String(value ?? '').trim()));
}

function createNameAllocator(values, reservedValues) {
  const normalizedValues = values.map((value) => String(value ?? '').trim());
  const reservedSet = new Set(
    reservedValues.map((value) => String(value ?? '').trim()).filter(Boolean),
  );
  const blankTotal = normalizedValues.filter((value) => !value).length;
  const blankConsumedFromHistory = reservedValues
    .map((value) => String(value ?? '').trim())
    .filter((value) => !value).length;
  let blankConsumed = Math.min(blankTotal, blankConsumedFromHistory);
  let cursor = 0;

  const nonEmptyAvailableCount = normalizedValues.filter(
    (value) => value && !reservedSet.has(value),
  ).length;
  const blankAvailableCount = Math.max(0, blankTotal - blankConsumed);

  return {
    availableCount: nonEmptyAvailableCount + blankAvailableCount,

    pickNext() {
      for (; cursor < normalizedValues.length; cursor += 1) {
        const candidate = normalizedValues[cursor];

        if (!candidate) {
          if (blankConsumed < blankTotal) {
            blankConsumed += 1;
            cursor += 1;
            return '';
          }

          continue;
        }

        if (reservedSet.has(candidate)) {
          continue;
        }

        reservedSet.add(candidate);
        cursor += 1;
        return candidate;
      }

      throw new Error('No unused name values remain in the identity pool.');
    },
  };
}

function createDescriptionAllocator(values, reservedValues) {
  const normalizedValues = values.map((value) => String(value ?? '').trim());
  const reservedSet = new Set(
    reservedValues.map((value) => String(value ?? '').trim()).filter(Boolean),
  );
  const blankTotal = normalizedValues.filter((value) => !value).length;
  const blankConsumedFromHistory = reservedValues
    .map((value) => String(value ?? '').trim())
    .filter((value) => !value).length;
  let blankConsumed = Math.min(blankTotal, blankConsumedFromHistory);
  let cursor = 0;

  const nonEmptyAvailableCount = normalizedValues.filter(
    (value) => value && !reservedSet.has(value),
  ).length;
  const blankAvailableCount = Math.max(0, blankTotal - blankConsumed);

  return {
    availableCount: nonEmptyAvailableCount + blankAvailableCount,

    pickNext() {
      for (; cursor < normalizedValues.length; cursor += 1) {
        const candidate = normalizedValues[cursor];

        if (!candidate) {
          if (blankConsumed < blankTotal) {
            blankConsumed += 1;
            cursor += 1;
            return '';
          }

          continue;
        }

        if (reservedSet.has(candidate)) {
          continue;
        }

        reservedSet.add(candidate);
        cursor += 1;
        return candidate;
      }

      throw new Error('No unused description values remain in the identity pool.');
    },
  };
}

async function resolveIdentitySelections({ requestedNickname, requestedDescription, limit }) {
  const requestedLimit = Number(limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error(`Limit must be a positive integer. Received: ${limit}`);
  }

  const usedIdentities = await readJsonFileWithDefault(USED_IDENTITIES_PATH, []);
  if (!Array.isArray(usedIdentities)) {
    throw new Error(`Used identities file must contain a JSON array: ${USED_IDENTITIES_PATH}`);
  }

  const refusedIdentities = await readJsonFileWithDefault(REFUSED_IDENTITIES_PATH, []);
  if (!Array.isArray(refusedIdentities)) {
    throw new Error(`Refused identities file must contain a JSON array: ${REFUSED_IDENTITIES_PATH}`);
  }

  const names = await loadStringArrayFile(NAMES_POOL_PATH, 'Names pool', { keepEmpty: true });
  const descriptions = await loadStringArrayFile(DESCRIPTIONS_POOL_PATH, 'Descriptions pool', {
    keepEmpty: true,
  });
  const emailEntries = await loadEmailEntryPoolFile(MY_EMAIL_POOL_PATH, 'My email pool');
  const blockedEmailSet = new Set(
    [...usedIdentities, ...refusedIdentities].map((entry) => normalizeEmail(entry?.email)).filter(Boolean),
  );
  const availableEmailEntries = emailEntries.filter((entry) => !blockedEmailSet.has(normalizeEmail(entry.email)));

  if (availableEmailEntries.length === 0) {
    throw new Error(`No unused email entries remain in ${MY_EMAIL_POOL_PATH}`);
  }

  const selectedEmailEntries = availableEmailEntries.slice(0, requestedLimit);
  const explicitNickname = String(requestedNickname ?? '').trim();
  const explicitDescription = String(requestedDescription ?? '').trim();
  const reservedNicknames = [...usedIdentities, ...refusedIdentities].map((entry) => entry?.nickname);
  const reservedDescriptions = [...usedIdentities, ...refusedIdentities].map((entry) => entry?.description);
  const nicknameAllocator = explicitNickname ? null : createNameAllocator(names, reservedNicknames);
  const descriptionAllocator = explicitDescription
    ? null
    : createDescriptionAllocator(descriptions, reservedDescriptions);
  const maxSelectable = Math.min(
    availableEmailEntries.length,
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

    throw new Error(`No unused email entries remain in ${MY_EMAIL_POOL_PATH}`);
  }

  const selectedCount = Math.min(requestedLimit, maxSelectable);
  if (selectedCount < requestedLimit) {
    console.warn(
      `Requested limit ${requestedLimit} exceeds remaining identity capacity ${selectedCount}. ` +
        `Continuing with ${selectedCount} email(s).`,
    );
  }

  return availableEmailEntries.slice(0, selectedCount).map((selectedEmailEntry) => {
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

    return {
      email: resolvedEmail,
      timestamp: selectedEmailEntry.timestamp,
      nickname: resolvedNickname,
      description: resolvedDescription,
    };
  });
}

function queueIdentityPoolWrite(task) {
  const queuedTask = identityPoolWriteQueue.then(task, task);
  identityPoolWriteQueue = queuedTask.catch(() => {});
  return queuedTask;
}

async function recordUsedIdentity(record) {
  return queueIdentityPoolWrite(async () => {
    const usedIdentities = await readJsonFileWithDefault(USED_IDENTITIES_PATH, []);
    if (!Array.isArray(usedIdentities)) {
      throw new Error(`Used identities file must contain a JSON array: ${USED_IDENTITIES_PATH}`);
    }

    const normalizedEmail = normalizeEmail(record?.email);
    const nextPayload = usedIdentities.filter(
      (entry) => normalizeEmail(entry?.email) !== normalizedEmail,
    );

    nextPayload.push(record);
    await ensureDirectory(IDENTITY_POOL_DIR);
    await writeFile(USED_IDENTITIES_PATH, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
  });
}

async function recordRefusedIdentity(record) {
  return queueIdentityPoolWrite(async () => {
    const refusedIdentities = await readJsonFileWithDefault(REFUSED_IDENTITIES_PATH, []);
    if (!Array.isArray(refusedIdentities)) {
      throw new Error(`Refused identities file must contain a JSON array: ${REFUSED_IDENTITIES_PATH}`);
    }

    const normalizedEmail = normalizeEmail(record?.email);
    const nextPayload = refusedIdentities.filter(
      (entry) => normalizeEmail(entry?.email) !== normalizedEmail,
    );

    nextPayload.push(record);
    await ensureDirectory(IDENTITY_POOL_DIR);
    await writeFile(REFUSED_IDENTITIES_PATH, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
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

async function allocateProjectIgnites({ accessToken, resolvedProjectId, allocationAmount }) {
  let hasFreshAllocation = false;
  let allocationStatus = null;

  try {
    await fetchAuthedJson(accessToken, '/ignites/allocate', {
      method: 'POST',
      body: {
        projectId: resolvedProjectId,
        amount: allocationAmount,
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

  const projectCapacity = await fetchAuthedJson(
    accessToken,
    `/ignites/capacity?projectId=${encodeURIComponent(resolvedProjectId)}`,
  );

  if (!hasFreshAllocation && allocationStatus === 'insufficient-capacity') {
    const existingAllocations = findProjectAllocations(projectCapacity, resolvedProjectId);
    const matchedAllocation = existingAllocations.find(
      (entry) => Number(entry?.amount ?? 0) >= allocationAmount,
    );

    if (matchedAllocation) {
      allocationStatus = 'already-allocated';
    }
  }

  return allocationStatus;
}

function logAllocationOutcome({ logPrefix, resolvedEmail, allocationStatus }) {
  if (allocationStatus === 'already-allocated') {
    console.log(`${logPrefix}Login completed and the requested ignites were already allocated for ${resolvedEmail}.`);
    return;
  }

  if (allocationStatus === 'allocated') {
    console.log(`${logPrefix}Login completed and ignites allocated for ${resolvedEmail}.`);
    return;
  }

  if (allocationStatus === 'insufficient-capacity') {
    console.log(`${logPrefix}Login completed but ignites could not be allocated for ${resolvedEmail} due to insufficient capacity.`);
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
}) {
  const resolvedEmail = String(identitySelection.email ?? '').trim();
  const resolvedNickname = String(identitySelection.nickname ?? '').trim();
  const resolvedDescription = String(identitySelection.description ?? '').trim();
  const mailboxTimestamp = String(identitySelection.timestamp ?? '').trim();
  const logPrefix = batchTotal > 1 ? `[${batchIndex + 1}/${batchTotal}] ` : '';
  const mailboxConfig = getSonjjMailboxConfig(resolvedEmail);

  if (!resolvedEmail) {
    throw new Error(`Email is required from ${MY_EMAIL_POOL_PATH}.`);
  }

  if (!isNumericString(mailboxTimestamp)) {
    throw new Error(`Mailbox timestamp is required from ${MY_EMAIL_POOL_PATH} for ${resolvedEmail}.`);
  }

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

  const { backendLogin, backendLoginTokens } = await exchangeBackendLogin({
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

  const { allocationStatus } = await allocateProjectIgnites({
    accessToken: backendLoginTokens.accessToken,
    resolvedProjectId,
    allocationAmount,
  });

  await recordUsedIdentity({
    email: resolvedEmail,
    nickname: resolvedNickname,
    description: resolvedDescription,
    allocationStatus,
    usedAt: new Date().toISOString(),
  });

  logAllocationOutcome({
    logPrefix,
    resolvedEmail,
    allocationStatus,
  });

  if (batchIndex < batchTotal - 1) {
    console.log(`${logPrefix}Completed ${resolvedEmail}. Proceeding to next email ...`);
  } else {
    console.log(`${logPrefix}Completed ${resolvedEmail}. All emails ended.`);
  }

  return {
    email: resolvedEmail,
    allocationStatus,
  };
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
  const allocationAmount = readIntegerSetting(args, envFile, {
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

  if (!resolvedProjectId) {
    throw new Error('Project id is required. Pass --project-id or set SURGE_PROJECT_ID.');
  }

  if (batchDelayMaxMs < batchDelayMinMs) {
    throw new Error(`Batch delay max must be greater than or equal to batch delay min. Received: min=${batchDelayMinMs}, max=${batchDelayMaxMs}`);
  }

  return {
    inviteCode,
    requestedNickname,
    requestedDescription,
    resolvedProjectId,
    allocationAmount,
    captchaToken,
    otpWaitMs,
    otpPollAttempts,
    requestedLimit,
    batchDelayMinMs,
    batchDelayMaxMs,
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
    allocationAmount,
    captchaToken,
    otpWaitMs,
    otpPollAttempts,
    requestedLimit,
    batchDelayMinMs,
    batchDelayMaxMs,
  } = runtimeConfig;

  const identitySelections = await resolveIdentitySelections({
    requestedNickname,
    requestedDescription,
    limit: requestedLimit,
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
      });

      batchResults.push(
        createBatchSuccessResult(batchIndex, identitySelection.email, result.allocationStatus),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
