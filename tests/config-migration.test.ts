import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateConfig, loadLegacyConfig } from "../src/config/migration.js";

describe("migrateConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("reports no migration needed when no config exists", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const result = await migrateConfig(tempDir);

    expect(result.migrated).toBe(false);
    expect(result.summary.some((s) => s.includes("No existing"))).toBe(true);
  });

  it("adds version and $schema to legacy config", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    // Legacy config without version or $schema
    const legacyConfig = { workflow: { defaultMode: "rigorous" } };
    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify(legacyConfig));

    const result = await migrateConfig(tempDir);

    expect(result.migrated).toBe(true);
    expect(result.summary.some((s) => s.includes("Added version"))).toBe(true);

    // Verify the migrated file
    const content = await readFile(path.join(leanrigorDir, "config.json"), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.$schema).toBeDefined();
    expect(parsed.workflow.defaultMode).toBe("rigorous"); // Preserved
  });

  it("preserves explicit model mappings", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    const config = {
      models: {
        tiers: {
          small: { claude: "my-custom-haiku" },
          medium: { claude: "my-custom-sonnet" }
        }
      }
    };
    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify(config));

    const result = await migrateConfig(tempDir);
    expect(result.migrated).toBe(true);

    const content = await readFile(path.join(leanrigorDir, "config.json"), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.models.tiers.small.claude).toBe("my-custom-haiku");
    expect(parsed.models.tiers.medium.claude).toBe("my-custom-sonnet");
  });

  it("is repeat-safe (idempotent)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify({ workflow: { defaultMode: "fast" } }));

    const first = await migrateConfig(tempDir);
    expect(first.migrated).toBe(true);

    const second = await migrateConfig(tempDir);
    expect(second.migrated).toBe(false); // Already migrated
    expect(second.summary.some((s) => s.includes("already current"))).toBe(true);
  });

  it("creates .gitignore during migration", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify({ version: 1 }));

    const migrationResult = await migrateConfig(tempDir);
    // Should have created .gitignore even though config was already versioned
    expect(migrationResult.summary.length).toBeGreaterThan(0);
    const gitignoreExists = await readFile(path.join(leanrigorDir, ".gitignore"), "utf8").catch(() => null);
    // The ensureGitignore is called, but if the leanrigor dir was created manually with just
    // the config.json, .gitignore gets created
    expect(gitignoreExists).not.toBeNull();
  });

  it("reports malformed JSON as warning", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    await writeFile(path.join(leanrigorDir, "config.json"), "{ not valid json }");

    const result = await migrateConfig(tempDir);
    expect(result.warnings.some((w) => w.includes("malformed JSON"))).toBe(true);
  });

  it("dry-run does not write files", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-migrate-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    const legacy = { workflow: { defaultMode: "standard" } };
    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify(legacy));

    const result = await migrateConfig(tempDir, true); // dryRun = true

    // In dry run, the file should remain unchanged
    const content = await readFile(path.join(leanrigorDir, "config.json"), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBeUndefined(); // Not added because dry-run
    expect(result.summary.some((s) => s.includes("Added version"))).toBe(true);
  });
});

describe("loadLegacyConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("loads legacy config without version metadata", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-legacy-"));
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await mkdir(leanrigorDir, { recursive: true });

    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify({
      workflow: { defaultMode: "rigorous" }
    }));

    const config = await loadLegacyConfig(tempDir);
    expect(config).not.toBeNull();
    if (config) {
      expect(config.workflow.defaultMode).toBe("rigorous");
      expect(config.version).toBe(1); // Schema default
    }
  });

  it("returns null when config does not exist", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-legacy-"));
    const config = await loadLegacyConfig(tempDir);
    expect(config).toBeNull();
  });
});
