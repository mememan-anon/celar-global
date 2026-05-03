import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const baseUrl = "https://app.sonjj.com";

const commands = {
  "check-email": { path: "/v1/check_email/", required: ["email"] },
  "check-gmail": { path: "/v1/check_gmail/", required: ["email"] },
  "check-microsoft": { path: "/v1/check_microsoft/", required: ["email"] },
  "check-disposable": { path: "/v1/check_disposable_email/", required: ["domain"] },
  "temp-domains": { path: "/v1/temp_email/domains", required: [] },
  "temp-create": { path: "/v1/temp_email/create", required: ["email"] },
  "temp-inbox": { path: "/v1/temp_email/inbox", required: ["email"] },
  "temp-message": { path: "/v1/temp_email/message", required: ["email", "mid"] },
  "gmail-list": { path: "/v1/temp_gmail/list", required: [], paginated: true },
  "gmail-random": { path: "/v1/temp_gmail/random", required: [] },
  "gmail-inbox": { path: "/v1/temp_gmail/inbox", required: ["email", "timestamp"] },
  "gmail-message": { path: "/v1/temp_gmail/message", required: ["email", "mid"] },
  "gmail-remove-message": { path: "/v1/temp_gmail/remove_message", required: ["email", "mid"] },
  "outlook-list": { path: "/v1/temp_outlook/list", required: [], paginated: true },
  "outlook-random": { path: "/v1/temp_outlook/random", required: [] },
  "outlook-inbox": { path: "/v1/temp_outlook/inbox", required: ["email", "timestamp"] },
  "outlook-message": { path: "/v1/temp_outlook/message", required: ["email", "mid"] }
};

function parseArgs(argv) {
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

async function loadEnvFile() {
  try {
    const raw = await readFile(envPath, "utf8");
    const entries = {};

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const [key, ...rest] = trimmed.split("=");
      entries[key.trim()] = rest.join("=").trim();
    }

    return entries;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function getApiKey() {
  const envFile = await loadEnvFile();

  return (
    process.env.SONJJ_API_KEY ||
    process.env.X_API_KEY ||
    envFile.SONJJ_API_KEY ||
    envFile.X_API_KEY ||
    envFile["X-Api-Key"]
  );
}

function buildParams(options) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(options)) {
    if (key === "_" || key === "all" || key === "max-pages") {
      continue;
    }

    if (value === undefined || value === null || value === false) {
      continue;
    }

    params.set(key.replace(/-/g, "_"), String(value));
  }

  return params;
}

async function requestJson(apiKey, endpointPath, options) {
  const params = buildParams(options);
  const url = params.size ? `${baseUrl}${endpointPath}?${params}` : `${baseUrl}${endpointPath}`;

  const response = await fetch(url, {
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.error?.message || response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  return data;
}

function ensureRequired(commandName, definition, options) {
  for (const key of definition.required) {
    if (!options[key]) {
      throw new Error(`Missing required flag --${key} for ${commandName}`);
    }
  }
}

async function runPaginated(apiKey, definition, options) {
  const firstPage = Number(options.page || 1);
  const maxPages = Number(options["max-pages"] || Number.MAX_SAFE_INTEGER);
  let page = firstPage;
  let pagesFetched = 0;
  let totalPages = null;
  const aggregate = [];
  let lastResponse = null;

  while (pagesFetched < maxPages) {
    const response = await requestJson(apiKey, definition.path, { ...options, page });
    const pageItems = Array.isArray(response?.data) ? response.data : [];

    aggregate.push(...pageItems);
    lastResponse = response;
    pagesFetched += 1;
    totalPages = response?.pagination?.total_pages ?? totalPages;

    if (!options.all || !totalPages || page >= totalPages) {
      break;
    }

    page += 1;
  }

  return {
    command: options._[0],
    fetched_pages: pagesFetched,
    aggregated_count: aggregate.length,
    pagination: lastResponse?.pagination ?? null,
    data: aggregate
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/sonjj-mail.mjs <command> [--flag value]",
    "",
    "Commands:",
    "  check-email --email <address>",
    "  check-gmail --email <gmail>",
    "  check-microsoft --email <outlook|hotmail|live|msn>",
    "  check-disposable --domain <domain>",
    "  temp-domains",
    "  temp-create --email <address> [--expiry-minutes 60]",
    "  temp-inbox --email <address>",
    "  temp-message --email <address> --mid <message-id>",
    "  gmail-list [--page 1] [--limit 10] [--type real|alias] [--password secret] [--all] [--max-pages 3]",
    "  gmail-random [--type real|alias] [--password secret]",
    "  gmail-inbox --email <gmail> --timestamp <unix-seconds>",
    "  gmail-message --email <gmail> --mid <message-id>",
    "  gmail-remove-message --email <gmail> --mid <message-id>",
    "  outlook-list [--page 1] [--limit 10] [--type real|alias] [--all] [--max-pages 3]",
    "  outlook-random [--type real|alias]",
    "  outlook-inbox --email <outlook> --timestamp <unix-seconds>",
    "  outlook-message --email <outlook> --mid <message-id>"
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commandName = options._[0];

  if (!commandName || commandName === "help" || commandName === "--help") {
    console.log(usage());
    return;
  }

  const definition = commands[commandName];
  if (!definition) {
    throw new Error(`Unknown command: ${commandName}\n\n${usage()}`);
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("Missing SonJJ API key. Add SONJJ_API_KEY, X_API_KEY, or X-Api-Key to .env.");
  }

  ensureRequired(commandName, definition, options);

  const payload = definition.paginated
    ? await runPaginated(apiKey, definition, options)
    : await requestJson(apiKey, definition.path, options);

  console.log(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
