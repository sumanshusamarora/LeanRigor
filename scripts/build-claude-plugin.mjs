#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("runtime", { recursive: true });

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "runtime/leanrigor-cli.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  banner: {
    js: "import { createRequire as __leanrigorCreateRequire } from 'node:module';\nconst require = __leanrigorCreateRequire(import.meta.url);"
  },
  legalComments: "none"
});

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const expectedVersion = pkg.version;
if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
  throw new Error("package.json must contain a non-empty version");
}

// Stamp the package version into the bundled runtime so it agrees with
// package.json — mirroring what verify-built-cli.mjs does for dist/cli/index.js.
let bundleSource = await readFile("runtime/leanrigor-cli.js", "utf8");
const versionPattern = /(\.version\(")([^"]+)("\))/;
if (!versionPattern.test(bundleSource)) {
  throw new Error("Could not locate the bundled CLI version declaration");
}
bundleSource = bundleSource.replace(versionPattern, `$1${expectedVersion}$3`);
await writeFile("runtime/leanrigor-cli.js", bundleSource, "utf8");

await writeFile("runtime/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");

const plugin = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8"));
const commitFromEnv = process.env.LEANRIGOR_GIT_COMMIT || process.env.GITHUB_SHA;
const normalizedCommit = commitFromEnv?.trim();
const gitCommit = normalizedCommit
  ? /^[0-9a-fA-F]{7,40}$/.test(normalizedCommit)
    ? normalizedCommit.slice(0, 12).toLowerCase()
    : normalizedCommit
  : "unknown";
const buildInfo = {
  generatedBy: "scripts/build-claude-plugin.mjs",
  packageVersion: pkg.version,
  pluginVersion: plugin.version,
  gitCommit,
};
await writeFile(".claude-plugin/build-info.json", JSON.stringify(buildInfo, null, 2) + "\n");
