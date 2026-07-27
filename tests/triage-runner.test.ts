import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { normaliseModelPayload, runTriage, type TriageProvider } from "../src/core/triage-runner.js";
import type { ModelTriageRecommendation } from "../src/core/types.js";

function providerFrom(values: unknown[]): TriageProvider {
  let index = 0;
  const next = () => {
    const raw = values[Math.min(index, values.length - 1)];
    index += 1;
    return { raw, provider: "fake-model", model: "small-test-model" };
  };
  return {
    name: "fake-model",
    async recommend() {
      return next();
    },
    async repairRecommendation() {
      return next();
    }
  };
}

function recommendation(overrides: Partial<ModelTriageRecommendation> = {}): ModelTriageRecommendation {
  return {
    version: 1,
    complexity: "medium",
    ambiguity: "low",
    blastRadius: "medium",
    risks: {
      architecturalImpact: "low",
      securityRisk: "none",
      dataIntegrityRisk: "none",
      operationalRisk: "none"
    },
    recommendedMode: "standard",
    confidence: 0.8,
    parallelism: "sequential",
    constraints: [],
    approachSummary: "Implement the requested change.",
    needsAdditionalInspection: false,
    inspectionQuestions: [],
    evidenceReferences: [],
    taskType: "feature",
    clarification: { required: false, question: null, reason: null },
    ...overrides
  };
}

describe("model-backed triage", () => {
  it("validates model output and applies deterministic overrides", async () => {
    const config = defaultConfig();

    const result = await runTriage({
      request: "Change authentication handling",
      root: process.cwd(),
      config,
      provider: providerFrom([recommendation({ recommendedMode: "fast", blastRadius: "low" })])
    });

    expect(result.source).toBe("model");
    expect(result.output.workflow.finalMode).toBe("rigorous");
    expect(result.output.workflow.overridden).toBe(true);
  });

  it("retries once after invalid output", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Fix the broken assignment API",
      root: process.cwd(),
      config,
      provider: providerFrom(["not json", recommendation({ taskType: "bug" })])
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
    expect(result.provider).toBe("fake-model");
    expect(result.attempts).toBe(2);
    expect(result.fallbackReason).toBe("model triage recommendation failed after 2 attempts");
    expect(result.warnings.at(-1)).toMatch(/deterministic policy/i);
  });

  it("supports Claude JSON envelopes and fenced JSON", () => {
    expect(normaliseModelPayload({ result: "```json\n{\"ok\":true}\n```" })).toEqual({ ok: true });
  });

  it("accepts legacy TriageOutput from older scripted providers", async () => {
    const config = defaultConfig();
    const legacy = assessLegacy("Change authentication migration handling for production credentials", config);
    const result = await runTriage({
      request: "Change authentication migration handling for production credentials",
      root: process.cwd(),
      config,
      provider: providerFrom([legacy])
    });

    expect(result.source).toBe("model");
    expect(result.output.workflow.finalMode).toBe("rigorous");
    expect(result.recommendation?.recommendedMode).toBe(legacy.workflow.modelRecommendation);
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
    expect(result.fallbackReason).toBe("automatic triage is disabled by configuration");
    expect(result.evidence.version).toBe(1);
  });

  it("labels explicit deterministic triage without attempting a model call", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Fix a typo in README",
      root: process.cwd(),
      config,
      providerSelection: "deterministic"
    });
    expect(result.source).toBe("deterministic-fallback");
    expect(result.provider).toBe("deterministic");
    expect(result.attempts).toBe(0);
    expect(result.fallbackReason).toBe("deterministic provider explicitly selected");
  });

  it("does not let model confidence turn unknown material risks into fast mode", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Improve assignment behavior",
      root: process.cwd(),
      config,
      provider: providerFrom([recommendation({ recommendedMode: "fast", complexity: "low", blastRadius: "low", confidence: 0.99 })])
    });

    expect(result.output.workflow.finalMode).toBe("standard");
    expect(result.policyDecision?.fastEligible).toBe(false);
    expect(result.output.workflow.overrideReason).toContain("material risk remains unknown");
  });

  it("runs targeted inspection only when concrete allowed paths are available", async () => {
    const config = defaultConfig();
    let inspected = false;
    const provider: TriageProvider = {
      name: "fake-model",
      async recommend() {
        if (inspected) return { raw: recommendation({ recommendedMode: "rigorous", evidenceReferences: ["changeSignals.publicContract"] }), provider: "fake-model" };
        return {
          raw: recommendation({
            needsAdditionalInspection: true,
            inspectionQuestions: [{ id: "q1", question: "Is this public?", reason: "Could affect mode.", allowedPaths: ["src/core/types.ts"] }]
          }),
          provider: "fake-model"
        };
      },
      async inspect() {
        inspected = true;
        return {
          provider: "fake-model",
          raw: {
            version: 1,
            findings: [{ key: "changeSignals.publicContract", value: true, confidence: "verified", source: "src/core/types.ts" }],
            evidenceReferences: ["src/core/types.ts"],
            exhaustedBudget: false
          }
        };
      }
    };

    const result = await runTriage({
      request: "Change `src/core/types.ts` public workflow schema",
      root: process.cwd(),
      config,
      provider
    });

    expect(result.inspection?.used).toBe(true);
    expect(result.output.workflow.finalMode).toBe("rigorous");
  });
});

function assessLegacy(request: string, config: ReturnType<typeof defaultConfig>) {
  return {
    version: 1,
    task: { type: "feature", summary: request },
    assessment: {
      complexity: "high",
      ambiguity: "low",
      blastRadius: "high",
      architecturalImpact: "high",
      securityRisk: "high",
      dataIntegrityRisk: "high",
      operationalRisk: "high"
    },
    workflow: {
      modelRecommendation: "rigorous",
      finalMode: "rigorous",
      confidence: 0.9,
      parallelism: "sequential",
      reviewLevel: config.review.rigorous,
      testLevel: "full",
      overridden: false,
      overrideReason: null
    },
    clarification: { required: false, question: null, reason: null },
    inspection: { required: false, targets: ["relevant implementation boundary"] },
    escalationReasons: ["Legacy high-risk trigger."],
    assumptions: [],
    constraints: { mustNot: ["commit, push, deploy, or write to production without explicit approval"] }
  };
}
