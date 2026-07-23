import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { defaultReviewLevel, shouldTriggerDeepReflection } from "../src/core/review-policy.js";

describe("review and introspection policy", () => {
  it("uses sanity review for fast and integrated review for standard", () => {
    expect(defaultReviewLevel("fast")).toBe("sanity");
    expect(defaultReviewLevel("standard")).toBe("integrated");
    expect(defaultReviewLevel("rigorous")).toBe("deep");
  });

  it("always integrates multi-agent work", () => {
    expect(defaultReviewLevel("fast", true)).toBe("integrated");
  });

  it("triggers reflection after the configured failed repair threshold", () => {
    const config = defaultConfig();
    expect(shouldTriggerDeepReflection({ trigger: "failed-repair", failedRepairCount: 1, config })).toBe(false);
    expect(shouldTriggerDeepReflection({ trigger: "failed-repair", failedRepairCount: 2, config })).toBe(true);
  });
});
