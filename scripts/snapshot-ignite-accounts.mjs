import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "https://back.surge.xyz/token-projects/28/ignite-leaderboard?type=ACTIVE&limit=5000";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "data", "ignite-account-snapshots");

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

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function findArrayPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidateKeys = ["entries", "data", "items", "results", "leaderboard"];
  for (const key of candidateKeys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  throw new Error("Expected the endpoint response to be an array or contain an array payload.");
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return null;
}

function extractAccount(entry) {
  const id = firstValue(
    entry?.userId,
    entry?.user?.id,
    entry?.accountId,
    entry?.account?.id,
    entry?.id,
  );
  const name = firstValue(
    entry?.nickname,
    entry?.user?.nickname,
    entry?.accountName,
    entry?.account?.name,
    entry?.name,
    entry?.username,
  );

  return {
    id: id === null ? null : String(id),
    name: name === null ? null : String(name),
  };
}

async function fetchAccounts(endpoint) {
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const rows = findArrayPayload(payload);

  return rows.map(extractAccount).filter((account) => account.id || account.name);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = String(args.endpoint ?? DEFAULT_ENDPOINT).trim();

  if (!endpoint) {
    throw new Error("Endpoint is required. Pass --endpoint or use the built-in default endpoint.");
  }

  await mkdir(outputDir, { recursive: true });

  const accounts = await fetchAccounts(endpoint);
  const timestamp = buildTimestamp();
  const outputPath = path.join(outputDir, `ignite-accounts-${timestamp}.json`);
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    endpoint,
    count: accounts.length,
    accounts,
  };

  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Saved ${accounts.length} account names and IDs to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
