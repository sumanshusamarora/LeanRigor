#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");

function bumpDevVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/);
  if (!match) {
    throw new Error(`Version '${version}' is not in supported dev format x.y.z-dev.n or x.y.z`);
  }

  const [, major, minor, patch, prerelease] = match;
  const next = prerelease === undefined ? 0 : Number(prerelease) + 1;
  return `${major}.${minor}.${patch}-dev.${next}`;
}

async function main() {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const previousVersion = pkg.version;
  const nextVersion = bumpDevVersion(previousVersion);

  pkg.version = nextVersion;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

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
