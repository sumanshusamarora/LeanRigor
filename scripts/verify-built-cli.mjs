#!/usr/bin/env node
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.LEANRIGOR_VERIFY_ROOT
  ? path.resolve(process.env.LEANRIGOR_VERIFY_ROOT)
  : defaultRoot;
const cliPath = path.join(root, "dist", "cli", "index.js");
const packagePath = path.join(root, "package.json");

async function main() {
  let source = await readFile(cliPath, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) {
    throw new Error("dist/cli/index.js must start with '#!/usr/bin/env node'");
  }

  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  const expectedVersion = pkg.version;
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new Error("package.json must contain a non-empty version");
  }

  const versionPattern = /(\.version\(")([^"]+)("\))/;
  if (!versionPattern.test(source)) {
    throw new Error("Could not locate the built CLI version declaration");
  }
  source = source.replace(versionPattern, `$1${expectedVersion}$3`);
  await writeFile(cliPath, source, "utf8");

  // TypeScript preserves the shebang but does not reliably preserve executable mode.
  await chmod(cliPath, 0o755);
  await access(cliPath, constants.X_OK);

  const result = spawnSync(process.execPath, [cliPath, "--version"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Built CLI version check failed: ${result.stderr || result.stdout}`);
  }

  const actualVersion = result.stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Built CLI version mismatch: package.json=${expectedVersion}, CLI=${actualVersion}`);
  }

  console.log(`Verified executable LeanRigor CLI ${actualVersion} at ${path.relative(root, cliPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
