#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");

function bumpDevVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`Version '${version}' is not in a supported semver format`); 
  }

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const prerelease = match[4];
  if (!prerelease) {
    return `${major}.${minor}.${patch}-dev.0`;
  }

  const devMatch = prerelease.match(/^dev\.(\d+)$/);
  const next = devMatch ? Number(devMatch[1]) + 1 : 0;
  return `${major}.${minor}.${patch}-dev.${next}`;
}

async function main() {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const previousVersion = pkg.version;
  const nextVersion = bumpDevVersion(previousVersion);

  const bump = spawnSync("npm", ["version", nextVersion, "--no-git-tag-version", "--allow-same-version"], {
    cwd: root,
    stdio: "inherit",
  });
  if (bump.status !== 0) {
    process.exit(bump.status ?? 1);
  }

  const sync = spawnSync("node", ["scripts/sync-versions.mjs"], { cwd: root, stdio: "inherit" });
  if (sync.status !== 0) {
    process.exit(sync.status ?? 1);
  }

  console.log(`${previousVersion} -> ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
