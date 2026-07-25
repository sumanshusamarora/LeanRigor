#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(root, "runtime", "leanrigor-cli.js");
const tmpDir = path.join(tmpdir(), `leanrigor-stale-check-${process.pid}`);

async function sha256(filePath) {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  await mkdir(tmpDir, { recursive: true });
  const fresh = path.join(tmpDir, "leanrigor-cli.js");

  try {
    // Build a fresh runtime bundle to the temp location using the exact
    // same esbuild configuration as build:claude-plugin.
    await build({
      entryPoints: [path.join(root, "src", "cli", "index.ts")],
      outfile: fresh,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      sourcemap: false,
      banner: {
        js: "import { createRequire as __leanrigorCreateRequire } from 'node:module';\nconst require = __leanrigorCreateRequire(import.meta.url);",
      },
      legalComments: "none",
    });

    // Stamp the package version into the fresh build so it matches what
    // build:claude-plugin produces (see build-claude-plugin.mjs).
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const expectedVersion = pkg.version;
    if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
      throw new Error("package.json must contain a non-empty version");
    }
    let freshSource = await readFile(fresh, "utf8");
    const versionPattern = /(\.version\(")([^"]+)("\))/;
    if (!versionPattern.test(freshSource)) {
      throw new Error("Could not locate the bundled CLI version declaration");
    }
    freshSource = freshSource.replace(versionPattern, `$1${expectedVersion}$3`);
    await writeFile(fresh, freshSource, "utf8");
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

    const committedHash = await sha256(runtimePath);
    const freshHash = await sha256(fresh);

    if (committedHash !== freshHash) {
      console.error("ERROR: Checked-in runtime/leanrigor-cli.js is stale.");
      console.error("The marketplace runtime bundle does not match a fresh rebuild from current source.");
      console.error("");
      console.error("This means the bundle was not regenerated after source changes.");
      console.error("Run `npm run build` to regenerate it, then commit the updated runtime/leanrigor-cli.js.");
      console.error("");
      console.error(`  Committed SHA256: ${committedHash}`);
      console.error(`  Fresh SHA256:     ${freshHash}`);
      process.exit(1);
    }

    console.log("Stale runtime check passed: runtime/leanrigor-cli.js matches a fresh rebuild.");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
