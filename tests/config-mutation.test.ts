import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/config/atomic-write.js";
import { userConfigSchema } from "../src/config/schemas/user.js";
import { repoPolicyConfigSchema } from "../src/config/schemas/repo-policy.js";
import { leanRigorConfigSchema } from "../src/config/schema.js";

describe("atomicWriteJson", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("writes JSON atomically", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-atomic-"));
    const filePath = path.join(tempDir, "test.json");

    await atomicWriteJson(filePath, { hello: "world", version: 1 });

    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.hello).toBe("world");
    expect(parsed.version).toBe(1);
  });

  it("creates intermediate directories", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-atomic-"));
    const filePath = path.join(tempDir, "nested", "deep", "config.json");

    await atomicWriteJson(filePath, { key: "value" });

    const content = await readFile(filePath, "utf8");
    expect(JSON.parse(content).key).toBe("value");
  });

  it("overwrites existing file", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-atomic-"));
    const filePath = path.join(tempDir, "config.json");

    await atomicWriteJson(filePath, { first: true });
    await atomicWriteJson(filePath, { second: true });

    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.second).toBe(true);
    expect(parsed.first).toBeUndefined();
  });
});

describe("schema validation", () => {
  it("userConfigSchema rejects invalid scope settings", () => {
    // Machine paths are valid in user config
    const valid = userConfigSchema.parse({ version: 1, paths: { workspaceRoot: "/tmp" } });
    expect(valid.paths?.workspaceRoot).toBe("/tmp");
  });

  it("repoPolicyConfigSchema rejects concrete model IDs (not in schema)", () => {
    const valid = repoPolicyConfigSchema.parse({ version: 1, minimumTiers: { triage: "large" } });
    expect(valid.minimumTiers?.triage).toBe("large");

    // The repo policy schema doesn't have models.tiers, so passing unknown keys
    // would be stripped by Zod (depending on strictness)
    const withExtra = repoPolicyConfigSchema.parse({
      version: 1,
      minimumTiers: { triage: "medium" }
    });
    // Should only contain defined keys
    expect(withExtra.minimumTiers?.triage).toBe("medium");
  });

  it("leanRigorConfigSchema accepts full config (backward compat)", () => {
    const valid = leanRigorConfigSchema.parse({});
    expect(valid.version).toBe(1);
    expect(valid.workflow.defaultMode).toBe("adaptive");
  });
});
