import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SURGE_BACKEND_URL = "https://back.surge.xyz";
const DEFAULT_PROJECT_ID = "28";
const DEFAULT_TYPE = "ACTIVE";
const DEFAULT_LIMIT = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const outputDir = path.join(projectRoot, "data", "ignite-leaderboard");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

async function loadEnvFile() {
  if (!existsSync(envPath)) {
    return {};
  }

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
}

function readSetting(args, envFile, argKey, envKey, fallbackValue) {
  return args[argKey] ?? process.env[envKey] ?? envFile[envKey] ?? fallbackValue;
}

function buildEndpoint({ projectId, type, limit }) {
  const searchParams = new URLSearchParams({
    type,
    limit: String(limit),
  });

  return `${SURGE_BACKEND_URL}/token-projects/${encodeURIComponent(projectId)}/ignite-leaderboard?${searchParams.toString()}`;
}

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function fetchLeaderboard({ endpoint }) {
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error("Expected the endpoint to return an array.");
  }

  return payload.map((entry) => ({
    userId: String(entry.userId ?? ""),
    nickname: entry.nickname ?? "",
    points: Number(entry.activeAmount ?? entry.amount ?? 0),
    rank: entry.rank ?? null
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = await loadEnvFile();
  const projectId = String(
    readSetting(args, envFile, "project-id", "SURGE_PROJECT_ID", DEFAULT_PROJECT_ID) ?? "",
  ).trim();
  const type = String(
    readSetting(args, envFile, "type", "SURGE_IGNITE_TYPE", DEFAULT_TYPE) ?? "",
  ).trim().toUpperCase();
  const limit = Number(
    readSetting(args, envFile, "limit", "SURGE_IGNITE_LIMIT", DEFAULT_LIMIT),
  );

  if (!projectId) {
    throw new Error("Project ID is required. Pass --project-id or set SURGE_PROJECT_ID.");
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Limit must be a positive integer. Received: ${limit}`);
  }

  const endpoint = buildEndpoint({ projectId, type, limit });
  await mkdir(outputDir, { recursive: true });

  const entries = await fetchLeaderboard({ endpoint });
  const timestamp = buildTimestamp();
  const outputPath = path.join(outputDir, `ignite-leaderboard-project-${projectId}-${timestamp}.json`);

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    projectId,
    type,
    limit,
    endpoint,
    count: entries.length,
    entries
  };

  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Saved ${entries.length} entries to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
