import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { assessTask } from "../src/core/assessment.js";
import { normaliseModelPayload, runTriage, type TriageProvider } from "../src/core/triage-runner.js";

function providerFrom(values: unknown[]): TriageProvider {
  let index = 0;
  return {
    name: "fake-model",
    async classify() {
      const raw = values[Math.min(index, values.length - 1)];
      index += 1;
      return { raw, provider: "fake-model", model: "small-test-model" };
    }
  };
}

describe("model-backed triage", () => {
  it("validates model output and applies deterministic overrides", async () => {
    const config = defaultConfig();
    const modelOutput = assessTask("Add a normal application feature", config);
    modelOutput.workflow.modelRecommendation = "fast";
    modelOutput.workflow.finalMode = "fast";
    modelOutput.assessment.securityRisk = "high";

    const result = await runTriage({
      request: "Change authentication handling",
      root: process.cwd(),
      config,
      provider: providerFrom([modelOutput])
    });

    expect(result.source).toBe("model");
    expect(result.output.workflow.finalMode).toBe("rigorous");
    expect(result.output.workflow.overridden).toBe(true);
  });

  it("retries once after invalid output", async () => {
    const config = defaultConfig();
    const valid = assessTask("Fix the broken assignment API", config);
    const result = await runTriage({
      request: "Fix the broken assignment API",
      root: process.cwd(),
      config,
      provider: providerFrom(["not json", valid])
    });
    expect(result.source).toBe("model");
    expect(result.attempts).toBe(2);
    expect(result.warnings).toHaveLength(1);
  });

  it("falls back deterministically after repeated invalid output", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Fix the broken assignment API",
      root: process.cwd(),
      config,
      provider: providerFrom(["bad", "still bad"])
    });
    expect(result.source).toBe("deterministic-fallback");
    expect(result.output.workflow.finalMode).toBe("standard");
    expect(result.warnings.at(-1)).toMatch(/fallback/i);
  });

  it("supports Claude JSON envelopes and fenced JSON", () => {
    expect(normaliseModelPayload({ result: "```json\n{\"ok\":true}\n```" })).toEqual({ ok: true });
  });

  it("skips model triage when automatic triage is disabled", async () => {
    const config = defaultConfig();
    config.workflow.automaticTriage = false;
    const result = await runTriage({
      request: "Fix a typo in README",
      root: process.cwd(),
      config,
      provider: providerFrom([{}])
    });
    expect(result.source).toBe("deterministic-fallback");
    expect(result.attempts).toBe(0);
  });
});
