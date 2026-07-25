import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(repoRoot, "scripts", "verify-built-cli.mjs");

async function fixture(packageVersion: string, cliVersion: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "leanrigor-cli-build-"));
  await mkdir(path.join(root, "dist", "cli"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ version: packageVersion }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "dist", "cli", "index.js"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(cliVersion)});\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  return root;
}

describe("built CLI verification", () => {
  it("repairs executable mode and accepts a matching version", async () => {
    const root = await fixture("1.2.3", "1.2.3");
    const result = spawnSync(process.execPath, [verifier], {
      env: { ...process.env, LEANRIGOR_VERIFY_ROOT: root },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified executable LeanRigor CLI 1.2.3");
    const mode = (await stat(path.join(root, "dist", "cli", "index.js"))).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("fails when the built CLI version differs from package.json", async () => {
    const root = await fixture("1.2.3", "1.2.2");
    const result = spawnSync(process.execPath, [verifier], {
      env: { ...process.env, LEANRIGOR_VERIFY_ROOT: root },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Built CLI version mismatch");
  });

  it("keeps the build wired to the verifier", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.build).toContain("node scripts/verify-built-cli.mjs");
  });
});
