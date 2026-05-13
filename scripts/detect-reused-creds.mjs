import fs from "node:fs";
import path from "node:path";

const DETECT_FROM_DATE = new Date("2026-05-10T00:00:00.000Z");

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getProfileCreatedAt(row) {
  return row?.user?.createdAt ?? row?.createdAt ?? null;
}

function wasCreatedOnOrAfter(row, fromDate) {
  const createdAt = getProfileCreatedAt(row);
  if (!createdAt) return false;

  const createdTime = new Date(createdAt).getTime();
  return Number.isFinite(createdTime) && createdTime >= fromDate.getTime();
}

function getCredentialKey(social) {
  const type = normalize(social?.type);
  const username = normalize(social?.username);
  const url = normalize(social?.url);

  if (!type) return null;

  const account = username || url;
  if (!account) return null;

  return {
    type,
    account,
    key: `${type}:${account}`,
  };
}

function readRows(filePath) {
  const absolutePath = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function collectReusedCredentials(rows, fromDate = DETECT_FROM_DATE) {
  const grouped = new Map();

  for (const row of rows) {
    if (!wasCreatedOnOrAfter(row, fromDate)) continue;

    const userId = String(row?.userId ?? row?.user?.id ?? "");
    const nickname = row?.nickname ?? row?.user?.nickname ?? null;

    for (const social of row?.user?.socials ?? []) {
      const credential = getCredentialKey(social);
      if (!credential) continue;

      const existing = grouped.get(credential.key) ?? {
        type: credential.type,
        account: credential.account,
        count: 0,
        users: [],
      };

      existing.count += 1;
      existing.users.push({ userId, nickname });
      grouped.set(credential.key, existing);
    }
  }

  return [...grouped.values()]
    .filter((entry) => entry.count > 1)
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.type.localeCompare(right.type) ||
        left.account.localeCompare(right.account),
    );
}

function collectProfilesWithReusedCredentials(results) {
  const profiles = new Map();

  for (const result of results) {
    for (const user of result.users) {
      const profileKey = `${user.userId}:${user.nickname ?? "null"}`;
      const existing = profiles.get(profileKey) ?? {
        userId: user.userId,
        nickname: user.nickname,
        reusedCredentials: [],
      };

      existing.reusedCredentials.push({
        type: result.type,
        account: result.account,
        reusedCount: result.count,
      });

      profiles.set(profileKey, existing);
    }
  }

  return [...profiles.values()]
    .map((profile) => ({
      ...profile,
      reusedCredentials: profile.reusedCredentials.sort(
        (left, right) =>
          right.reusedCount - left.reusedCount ||
          left.type.localeCompare(right.type) ||
          left.account.localeCompare(right.account),
      ),
    }))
    .sort(
      (left, right) =>
        right.reusedCredentials.length - left.reusedCredentials.length ||
        String(left.nickname ?? "").localeCompare(String(right.nickname ?? "")) ||
        left.userId.localeCompare(right.userId),
    );
}

function printResults(results, fromDate = DETECT_FROM_DATE) {
  const dateLabel = fromDate.toISOString().slice(0, 10);

  if (!results.length) {
    console.log(`No reused credentials found for profiles created on or after ${dateLabel}.`);
    return;
  }

  const profiles = collectProfilesWithReusedCredentials(results);
  const totalReusedCredentials = results.length;
  const totalAffectedProfiles = profiles.length;

  console.log(`Detection start date: ${dateLabel}`);
  console.log(`Total reused credentials: ${totalReusedCredentials}`);
  console.log(`Total affected profiles: ${totalAffectedProfiles}`);
  console.log("");
  console.log("Reused credentials:");
  for (const result of results) {
    console.log(`- ${result.type}:${result.account} -> ${result.count} profiles`);
  }
  console.log("");
  console.log("Profiles with reused credentials:");

  for (const profile of profiles) {
    console.log(`${profile.nickname ?? "null"} (${profile.userId})`);
    for (const credential of profile.reusedCredentials) {
      console.log(
        `  - ${credential.type} -> ${credential.account} (used by ${credential.reusedCount} profiles)`,
      );
    }
  }
}

function main() {
  const inputPath = process.argv[2] ?? "rara.json";
  const rows = readRows(inputPath);
  const results = collectReusedCredentials(rows, DETECT_FROM_DATE);
  printResults(results, DETECT_FROM_DATE);
}

main();
