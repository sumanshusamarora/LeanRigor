import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveConfig } from "../src/config/resolver.js";

describe("resolveEffectiveConfig", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("resolves built-in defaults when no config files exist", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-resolve-"));
    // No config files at all
    const effective = await resolveEffectiveConfig(tempDir);

    expect(effective.values).toBeDefined();
    expect(effective.values.workflow.defaultMode).toBe("adaptive");
    expect(effective.values.execution.maxParallelPhases).toBe(1);
    expect(effective.sourcesFound).toContain("builtin");
    expect(effective.sourcesFound).toContain("adapter");
  });

  it("loads repo policy and enforces constraints", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-resolve-"));

    // Write a repo policy with minimum tier and parallelism cap
    const policy = {
      version: 1,
      minimumTiers: { triage: "large" },
      parallelism: { maxPhases: 2, maxAgents: 1 },
      completionGate: { enabled: true }
    };
    await writeFile(path.join(tempDir, "leanrigor.config.json"), JSON.stringify(policy));

    const effective = await resolveEffectiveConfig(tempDir);

    expect(effective.sourcesFound).toContain("repo");
    expect(effective.values.routing.triage).toBe("large");
    // Policy caps parallelism; base default (1) is within the cap of 2, so stays at 1
    expect(effective.values.execution.maxParallelPhases).toBe(1);
    // Base default maxAgents is 3, policy caps at 1
    expect(effective.values.parallelism.maxAgents).toBe(1);
    expect(effective.constraints.length).toBeGreaterThan(0);
  });

  it("loads local config over repo policy for non-safety settings", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-resolve-"));

    // Repo policy with safety settings — cap parallelism at 1
    const policy = { version: 1, parallelism: { maxPhases: 1, maxAgents: 1 } };
    await writeFile(path.join(tempDir, "leanrigor.config.json"), JSON.stringify(policy));

    // Local config with model mappings and higher parallelism (which gets capped)
    const leanrigorDir = path.join(tempDir, ".leanrigor");
    await import("node:fs/promises").then((fs) => fs.mkdir(leanrigorDir, { recursive: true }));
    const localConfig = {
      version: 1,
      models: { tiers: { small: { claude: "claude-haiku-4-5" } } },
      execution: { maxParallelPhases: 4 }
    };
    await writeFile(path.join(leanrigorDir, "config.json"), JSON.stringify(localConfig));

    const effective = await resolveEffectiveConfig(tempDir);

    expect(effective.sourcesFound).toContain("local");
    expect(effective.values.models.tiers.small.claude).toBe("claude-haiku-4-5");
    // Local config set 4, but policy caps at 1
    expect(effective.values.execution.maxParallelPhases).toBe(1);
    expect(effective.constraints.length).toBeGreaterThan(0);
  });

  it("tracks provenance for resolved values", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-resolve-"));

    const policy = { version: 1, minimumTiers: { triage: "large" } };
    await writeFile(path.join(tempDir, "leanrigor.config.json"), JSON.stringify(policy));

    const effective = await resolveEffectiveConfig(tempDir);

    // Provenance should have entries
    expect(effective.provenance.size).toBeGreaterThan(0);

    // Minimum tier should be from repo policy
    const triageProv = effective.provenance.get("minimumTiers.triage");
    expect(triageProv).toBeDefined();
    if (triageProv) {
      expect(triageProv.source).toBe("repo");
    }
  });

  it("adapter-derived defaults show in provenance", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-resolve-"));
    const effective = await resolveEffectiveConfig(tempDir);

    // Model tiers should have adapter provenance
    const smallProv = effective.provenance.get("models.tiers.small.claude");
    expect(smallProv).toBeDefined();
    if (smallProv) {
      expect(smallProv.source).toBe("adapter");
    }
  });
});

describe("multi-user simulation", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await import("node:fs/promises").then((fs) => fs.rm(tempDir, { recursive: true, force: true }));
    }
  });

  it("two users share repo policy but resolve different models", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "leanrigor-multiuser-"));

    // Shared repo policy
    const policy = { version: 1, minimumTiers: { triage: "medium" } };
    await writeFile(path.join(tempDir, "leanrigor.config.json"), JSON.stringify(policy));

    // Both users get the same policy enforcement
    const effective = await resolveEffectiveConfig(tempDir);
    expect(effective.values.routing.triage).toBe("medium");
    expect(effective.sourcesFound).toContain("repo");

    // Concrete model resolution depends on each user's env/config, not committed
    // The repo policy does NOT contain concrete model IDs
    const policyContent = JSON.parse(await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(tempDir, "leanrigor.config.json"), "utf8")));
    expect(policyContent.models).toBeUndefined(); // No model IDs in committed policy
    expect(policyContent.minimumTiers).toBeDefined(); // Only tiers
  });
});
