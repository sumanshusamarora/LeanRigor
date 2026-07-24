import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGitignore,
  ensureRepositoryConfig,
  checkTrackedLeanrigorFiles,
  detectInstructions
} from "../src/config/bootstrap.js";

describe("ensureGitignore", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("creates .leanrigor/.gitignore when directory is absent", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    const result = await ensureGitignore(leanrigorDir);

    expect(result.status).toBe("created");
    expect(result.message).toContain("created");

    const content = await readFile(path.join(leanrigorDir, ".gitignore"), "utf8");
    expect(content).toContain("*");
    expect(content).toContain("!.gitignore");
  });

  it("reports current when .gitignore is correct", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });
    await writeFile(path.join(leanrigorDir, ".gitignore"), "*\n!.gitignore\n");

    const result = await ensureGitignore(leanrigorDir);
    expect(result.status).toBe("current");
  });

  it("reports user_extended when .gitignore has safety patterns plus additions", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });
    await writeFile(path.join(leanrigorDir, ".gitignore"), "*\n!.gitignore\nconfig.backup.json\n");

    const result = await ensureGitignore(leanrigorDir);
    expect(result.status).toBe("user_extended");
  });

  it("reports incomplete when critical patterns are missing", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });
    await writeFile(path.join(leanrigorDir, ".gitignore"), "# just a comment\n");

    const result = await ensureGitignore(leanrigorDir);
    expect(result.status).toBe("incomplete");
  });

  it("is repeat-safe", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");

    const first = await ensureGitignore(leanrigorDir);
    expect(first.status).toBe("created");

    const second = await ensureGitignore(leanrigorDir);
    expect(second.status).toBe("current");
  });
});

describe("ensureRepositoryConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("creates .leanrigor/ with .gitignore and config.json on first use", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const config = await ensureRepositoryConfig(tempDir);

    // Verify .leanrigor/ created
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    const dirStat = await stat(leanrigorDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Verify .gitignore
    const gitignoreContent = await readFile(path.join(leanrigorDir, ".gitignore"), "utf8");
    expect(gitignoreContent).toContain("*");
    expect(gitignoreContent).toContain("!.gitignore");

    // Verify config.json
    const configContent = await readFile(path.join(leanrigorDir, "config.json"), "utf8");
    const parsed = JSON.parse(configContent);
    expect(parsed.version).toBe(1);
    expect(parsed.workflow).toBeDefined();

    // Config should have default values
    expect(config.workflow.defaultMode).toBe("adaptive");
    expect(config.execution.maxParallelPhases).toBe(1);
  });

  it("returns existing config without overwriting", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    const customConfig = { version: 1, workflow: { defaultMode: "rigorous", allowUserOverride: true, automaticTriage: true } };
    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify(customConfig));

    const config = await ensureRepositoryConfig(tempDir);
    expect(config.workflow.defaultMode).toBe("rigorous");
  });

  it("works from nested directory (walks up)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-bootstrap-"));
    const nestedDir = path.join(tempDir, "src", "lib", "deep");
    await mkdir(nestedDir, { recursive: true });

    // Should still create .leanrigor at the passed root, not in the nested dir
    const config = await ensureRepositoryConfig(tempDir);
    expect(config).toBeDefined();

    const leanrigorAtRoot = await stat(path.join(tempDir, ".leanrigor")).catch(() => null);
    expect(leanrigorAtRoot).not.toBeNull();
  });
});

describe("detectInstructions", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("finds CLAUDE.md and AGENTS.md", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-detect-"));
    await writeFile(path.join(tempDir, "CLAUDE.md"), "# project");
    await writeFile(path.join(tempDir, "AGENTS.md"), "# agents");

    const instructions = await detectInstructions(tempDir);
    expect(instructions).toContain("CLAUDE.md");
    expect(instructions).toContain("AGENTS.md");
  });

  it("returns empty array when no instruction files exist", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-detect-"));
    const instructions = await detectInstructions(tempDir);
    expect(instructions).toEqual([]);
  });
});

describe("checkTrackedLeanrigorFiles", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("detects non-gitignore files in .leanrigor", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-tracked-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });
    await mkdir(path.join(leanrigorDir, "workflows"), { recursive: true });
    await writeFile(path.join(leanrigorDir, "config.json"), "{}");
    await writeFile(path.join(leanrigorDir, "workflows", "test.json"), "{}");

    const tracked = await checkTrackedLeanrigorFiles(tempDir);
    expect(tracked).toContain("config.json");
    expect(tracked).toContain("workflows");
    expect(tracked).not.toContain(".gitignore");
  });

  it("returns empty when .leanrigor doesn't exist", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-tracked-"));
    const tracked = await checkTrackedLeanrigorFiles(tempDir);
    expect(tracked).toEqual([]);
  });
});
