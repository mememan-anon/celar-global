import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT =
  "https://back.surge.xyz/token-projects/28/ignite-leaderboard?type=ACTIVE&limit=500";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "data", "ignite-leaderboard");

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function fetchLeaderboard() {
  const response = await fetch(ENDPOINT, {
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
    points: Number(entry.activeAmount ?? 0)
  }));
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const entries = await fetchLeaderboard();
  const timestamp = buildTimestamp();
  const outputPath = path.join(outputDir, `ignite-leaderboard-${timestamp}.json`);

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
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
