import { describe, expect, it } from "vitest";
import { mergeValue } from "../src/config/merger.js";
import { applyRepoPolicy, applyUserConfig } from "../src/config/merger.js";
import { defaultConfig } from "../src/config/defaults.js";
import { repoPolicyConfigSchema } from "../src/config/schemas/repo-policy.js";
import { userConfigSchema } from "../src/config/schemas/user.js";

describe("mergeValue", () => {
  it("preference: higher precedence wins", () => {
    expect(mergeValue("a", "b", "preference")).toBe("b");
    expect(mergeValue("a", undefined, "preference")).toBe("a");
    expect(mergeValue(undefined, "b", "preference")).toBe("b");
    expect(mergeValue(undefined, undefined, "preference")).toBeUndefined();
  });

  it("maximum: lowest value wins (cap)", () => {
    expect(mergeValue(4, 2, "maximum")).toBe(2);
    expect(mergeValue(1, 3, "maximum")).toBe(1);
    expect(mergeValue(undefined, 2, "maximum")).toBe(2);
  });

  it("minimum_tier: strongest (highest) requirement wins", () => {
    expect(mergeValue("small", "large", "minimum_tier")).toBe("large");
    expect(mergeValue("large", "small", "minimum_tier")).toBe("large");
    expect(mergeValue("inherit", "medium", "minimum_tier")).toBe("medium");
  });

  it("mandatory: true wins", () => {
    expect(mergeValue(false, true, "mandatory")).toBe(true);
    expect(mergeValue(true, false, "mandatory")).toBe(true);
    expect(mergeValue(false, false, "mandatory")).toBe(false);
  });

  it("union: arrays are concatenated and deduplicated", () => {
    const result = mergeValue(["a", "b"], ["b", "c"], "union");
    expect(result).toEqual(["a", "b", "c"]);
  });
});

describe("applyRepoPolicy", () => {
  it("enforces minimum tier requirement", () => {
    const base = defaultConfig();
    const policy = repoPolicyConfigSchema.parse({ minimumTiers: { triage: "large" } });

    const { config, constraints } = applyRepoPolicy(base, policy);
    expect(config.routing.triage).toBe("large");
    expect(constraints.some((c) => c.includes("routing.triage"))).toBe(true);
  });

  it("caps maximum parallelism", () => {
    const base = defaultConfig();
    base.parallelism.maxAgents = 8;
    base.execution.maxParallelPhases = 4;

    const policy = repoPolicyConfigSchema.parse({ parallelism: { maxPhases: 2, maxAgents: 3 } });

    const { config, constraints } = applyRepoPolicy(base, policy);
    expect(config.execution.maxParallelPhases).toBe(2);
    expect(config.parallelism.maxAgents).toBe(3);
    expect(constraints.length).toBeGreaterThanOrEqual(2);
  });

  it("does not increase values when repo policy is more permissive", () => {
    const base = defaultConfig();
    base.parallelism.maxAgents = 2;

    const policy = repoPolicyConfigSchema.parse({ parallelism: { maxAgents: 10 } });

    const { config } = applyRepoPolicy(base, policy);
    // Base was 2, policy says 10 — but policy acts as a cap, so it stays at 2
    expect(config.parallelism.maxAgents).toBe(2);
  });

  it("forces completion gate enabled via safety policy", () => {
    const base = defaultConfig();
    base.completionGate.enabled = false;

    const policy = repoPolicyConfigSchema.parse({ completionGate: { enabled: true } });

    const { config, constraints } = applyRepoPolicy(base, policy);
    expect(config.completionGate.enabled).toBe(true);
    expect(constraints.some((c) => c.includes("completionGate.enabled"))).toBe(true);
  });

  it("caps max repair attempts", () => {
    const base = defaultConfig();
    base.completionGate.maxRepairAttempts.fast = 5;

    const policy = repoPolicyConfigSchema.parse({ safety: { maxRepairAttempts: { fast: 2 } } });

    const { config } = applyRepoPolicy(base, policy);
    expect(config.completionGate.maxRepairAttempts.fast).toBe(2);
  });

  it("applies repo policy review settings", () => {
    const base = defaultConfig();
    const policy = repoPolicyConfigSchema.parse({ review: { fast: "deep", allowUserOverride: false } });

    const { config } = applyRepoPolicy(base, policy);
    expect(config.review.fast).toBe("deep");
    expect(config.review.allowUserOverride).toBe(false);
  });
});

describe("applyUserConfig", () => {
  it("applies user model mappings", () => {
    const base = defaultConfig();
    const user = userConfigSchema.parse({ models: { claude: { small: "custom-haiku", medium: "custom-sonnet", large: "custom-opus" } } });

    const config = applyUserConfig(base, user);
    expect(config.models.tiers.small.claude).toBe("custom-haiku");
    expect(config.models.tiers.medium.claude).toBe("custom-sonnet");
    expect(config.models.tiers.large.claude).toBe("custom-opus");
  });

  it("applies user execution preferences", () => {
    const base = defaultConfig();
    const user = userConfigSchema.parse({ execution: { pollIntervalSeconds: 10, workerTimeoutSeconds: 3600, parallelism: 4 } });

    const config = applyUserConfig(base, user);
    expect(config.execution.pollIntervalSeconds).toBe(10);
    expect(config.execution.workerTimeoutSeconds).toBe(3600);
    expect(config.execution.maxParallelPhases).toBe(4);
  });
});
