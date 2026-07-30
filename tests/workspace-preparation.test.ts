import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { preparePhaseWorkspace } from "../src/core/workspace-preparation.js";

describe("workspace preparation contract", () => {
  it("makes validation dispatchable after a successful lockfile-preserving bootstrap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "leanrigor-preparation-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { example: "1.0.0" },
      scripts: { test: "example" }
    }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {}
    }));
    const fakeNpm = path.join(bin, "npm");
    await writeFile(fakeNpm, "#!/bin/sh\nexit 0\n");
    await chmod(fakeNpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      const config = defaultConfig();
      config.execution.dependencyBootstrap = "auto-lockfile";
      const result = await preparePhaseWorkspace({
        workspacePath: root,
        repositoryRoot: root,
        repositoryIdentity: "fixture",
        basis: { branch: "fixture", commit: "abc123" },
        validationCommands: ["npm test"],
        config
      });

      expect(result.status).toBe("prepared");
      expect(result.dependencies).toBe("available");
      expect(result.validationCommandsAvailable).toBe(true);
      expect(result.bootstrapCommand).toBe("npm ci --ignore-scripts");
      expect(result.commandRisk.lifecycleScripts).toBe(false);
      expect(result.evidence).toContain("bootstrap exit status 0");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
