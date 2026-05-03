import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const outputDir = path.join(projectRoot, "data", "sonjj-outlook-real");
const baseUrl = "https://app.sonjj.com";
const endpointPath = "/v1/temp_outlook/list";
const pageSize = 100;

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function requestPage(apiKey, page, attempt = 1) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(pageSize),
    type: "real"
  });
  const url = `${baseUrl}${endpointPath}?${params}`;

  const response = await fetch(url, {
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (response.status === 429 && attempt <= 5) {
    const retryAfterSeconds = Number(response.headers.get("Retry-After") || "2");
    await sleep(retryAfterSeconds * 1000);
    return requestPage(apiKey, page, attempt + 1);
  }

  if (!response.ok) {
    const message = data?.error?.message || response.statusText || "Request failed";
    throw new Error(`Page ${page}: ${response.status} ${message}`);
  }

  return data;
}

async function fetchAllRealOutlooks(apiKey) {
  const pages = [];
  const emails = [];
  const seen = new Set();
  let page = 1;
  let totalPages = null;
  let totalCount = null;

  while (totalPages === null || page <= totalPages) {
    const payload = await requestPage(apiKey, page);
    const pageData = Array.isArray(payload?.data) ? payload.data : [];
    const pagination = payload?.pagination ?? {};

    totalPages = Number(pagination.total_pages || 0) || totalPages || page;
    totalCount = Number(pagination.total_count || 0) || totalCount;

    pages.push({
      page,
      groups: pageData.length,
      emails: pageData.reduce(
        (sum, item) => sum + (Array.isArray(item?.emails) ? item.emails.length : 0),
        0
      ),
      timestampSample: pageData[0]?.timestamp ?? null
    });

    for (const group of pageData) {
      const timestamp = Number(group?.timestamp ?? 0) || null;
      const groupEmails = Array.isArray(group?.emails) ? group.emails : [];

      for (const value of groupEmails) {
        const email = String(value ?? "").trim();
        if (!email || seen.has(email)) {
          continue;
        }

        seen.add(email);
        emails.push({ email, timestamp });
      }
    }

    page += 1;
  }

  return {
    totalCount,
    totalPages,
    pageSize,
    emails,
    pages
  };
}

async function main() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("Missing SonJJ API key. Add SONJJ_API_KEY, X_API_KEY, or X-Api-Key to .env.");
  }

  await mkdir(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const result = await fetchAllRealOutlooks(apiKey);
  const finishedAt = new Date().toISOString();
  const outputPath = path.join(outputDir, `sonjj-outlook-real-${buildTimestamp()}.json`);

  const snapshot = {
    fetchedAt: finishedAt,
    startedAt,
    endpoint: `${baseUrl}${endpointPath}`,
    query: {
      type: "real",
      limit: pageSize
    },
    count: result.emails.length,
    totalCount: result.totalCount,
    totalPages: result.totalPages,
    pages: result.pages,
    entries: result.emails
  };

  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Saved ${snapshot.count} real Outlook entries to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
