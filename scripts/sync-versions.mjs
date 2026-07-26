#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const packagePath = path.join(root, "package.json");
const pluginManifestPath = path.join(root, ".claude-plugin", "plugin.json");
const marketplaceManifestPath = path.join(root, ".claude-plugin", "marketplace.json");
const cliSourcePath = path.join(root, "src", "cli", "index.ts");

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const plugin = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  const marketplace = JSON.parse(await readFile(marketplaceManifestPath, "utf8"));
  const cliSource = await readFile(cliSourcePath, "utf8");

  const version = pkg.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version must be a non-empty string");
  }

  plugin.version = version;
  if (Array.isArray(marketplace.plugins)) {
    for (const entry of marketplace.plugins) {
      if (entry?.name === "leanrigor") {
        entry.version = version;
      }
    }
  }

  const nextPlugin = stableJson(plugin);
  const nextMarketplace = stableJson(marketplace);
  const cliVersionPattern = /(program\.name\("leanrigor"\)\.description\("Adaptive rigor and model routing for AI coding agents"\)\.version\(")([^"]+)("\);)/;
  if (!cliVersionPattern.test(cliSource)) {
    throw new Error("src/cli/index.ts: could not find CLI version declaration");
  }
  const nextCliSource = cliSource.replace(cliVersionPattern, `$1${version}$3`);

  const currentPlugin = await readFile(pluginManifestPath, "utf8");
  const currentMarketplace = await readFile(marketplaceManifestPath, "utf8");

  const changes = [
    currentPlugin !== nextPlugin ? pluginManifestPath : null,
    currentMarketplace !== nextMarketplace ? marketplaceManifestPath : null,
    cliSource !== nextCliSource ? cliSourcePath : null,
  ].filter(Boolean);

  if (checkOnly) {
    if (changes.length > 0) {
      console.error("Version synchronization check failed for:");
      for (const changed of changes) console.error(`- ${path.relative(root, changed)}`);
      console.error("Run: npm run version:sync");
      process.exit(1);
    }
    console.log("Version synchronization check passed.");
    return;
  }

  await writeFile(pluginManifestPath, nextPlugin, "utf8");
  await writeFile(marketplaceManifestPath, nextMarketplace, "utf8");
  await writeFile(cliSourcePath, nextCliSource, "utf8");

  if (changes.length === 0) {
    console.log(`All versioned assets are already synced at ${version}.`);
    return;
  }

  console.log(`Synchronized versioned assets to ${version}:`);
  for (const changed of changes) {
    console.log(`- ${path.relative(root, changed)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
