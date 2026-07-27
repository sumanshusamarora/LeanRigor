import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { normaliseModelPayload, runTriage, type TriageProvider } from "../src/core/triage-runner.js";
import type { ModelTriageRecommendation, ReferencedWorkItem } from "../src/core/types.js";
import type { WorkItemResolver } from "../src/core/work-item-resolver.js";

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

  it("does not let model-requested repository scope clarification block a detailed issue", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Implement GitHub issue #12: deterministic test-obligation planning and evidence gates.",
      root: process.cwd(),
      config,
      workItemResolver: resolverFrom(detailedIssue(12)),
      provider: providerFrom([
        recommendation({
          recommendedMode: "rigorous",
          ambiguity: "high",
          blastRadius: "high",
          confidence: 0.35,
          clarification: {
            required: true,
            question: "What is the specific scope and affected subsystems for issue #12's test-obligation planning and evidence gates?",
            reason: "High ambiguity from sparse specification prevents accurate risk assessment and mode selection."
          }
        })
      ])
    });

    expect(result.evidence.referencedWorkItems?.[0]?.contentStatus).toBe("resolved");
    expect(result.output.workflow.finalMode).toBe("rigorous");
    expect(result.output.clarification.required).toBe(false);
    expect(result.output.clarificationDecision).toMatchObject({
      ownership: "already-resolved",
      disposition: "suppressed",
      finalRequired: false
    });
  });

  it("runs bounded inspection for repository-owned clarification when scope can be derived", async () => {
    const config = defaultConfig();
    let inspected = false;
    const provider: TriageProvider = {
      name: "fake-model",
      async recommend() {
        return {
          raw: recommendation({
            clarification: {
              required: true,
              question: "Which subsystems are affected by the workflow planning evidence gate change?",
              reason: "Repository scope should be checked."
            }
          }),
          provider: "fake-model"
        };
      },
      async inspect(input) {
        inspected = true;
        expect(input.inspection.allowedPaths).toEqual(expect.arrayContaining(["src/core/flow.ts", "src/core/planning-runner.ts", "tests"]));
        return {
          provider: "fake-model",
          raw: {
            version: 1,
            findings: [{ key: "repository.boundary.workflow", value: ["src/core/flow.ts"], confidence: "verified", source: "src/core/flow.ts" }],
            evidenceReferences: ["src/core/flow.ts"],
            exhaustedBudget: false
          }
        };
      }
    };

    const result = await runTriage({
      request: "Implement workflow planning evidence gates",
      root: process.cwd(),
      config,
      provider
    });

    expect(inspected).toBe(true);
    expect(result.inspection?.used).toBe(true);
    expect(result.output.clarification.required).toBe(false);
    expect(result.output.clarificationDecision).toMatchObject({
      ownership: "repository-discoverable",
      disposition: "deferred",
      finalRequired: false
    });
  });

  it("keeps safety-critical model clarification blocking", async () => {
    const config = defaultConfig();
    const result = await runTriage({
      request: "Change public API compatibility behaviour",
      root: process.cwd(),
      config,
      provider: providerFrom([
        recommendation({
          recommendedMode: "rigorous",
          clarification: {
            required: true,
            question: "Is an intentional public API breaking change acceptable?",
            reason: "Public-contract break permission must be explicit."
          }
        })
      ])
    });

    expect(result.output.workflow.finalMode).toBe("rigorous");
    expect(result.output.clarification.required).toBe(true);
    expect(result.output.clarificationDecision).toMatchObject({
      ownership: "safety-critical",
      disposition: "accepted",
      finalRequired: true
    });
  });

  it("defers planning-detail clarification instead of blocking triage", async () => {
    const result = await runTriage({
      request: "Implement workflow planning evidence gates",
      root: process.cwd(),
      config: defaultConfig(),
      provider: providerFrom([
        recommendation({
          recommendedMode: "rigorous",
          clarification: {
            required: true,
            question: "What exact phase decomposition and implementation order should be used?",
            reason: "Planning still needs implementation details."
          }
        })
      ])
    });

    expect(result.output.clarification.required).toBe(false);
    expect(result.output.clarificationDecision).toMatchObject({
      ownership: "planning-detail",
      disposition: "suppressed",
      finalRequired: false
    });
  });

  it("keeps destructive production intent clarification blocking", async () => {
    const result = await runTriage({
      request: "Change production migration cleanup behavior",
      root: process.cwd(),
      config: defaultConfig(),
      provider: providerFrom([
        recommendation({
          recommendedMode: "rigorous",
          clarification: {
            required: true,
            question: "Is destructive deletion of production data acceptable?",
            reason: "Data loss permission must be explicit."
          }
        })
      ])
    });

    expect(result.output.clarification.required).toBe(true);
    expect(result.output.clarificationDecision).toMatchObject({
      ownership: "safety-critical",
      disposition: "accepted",
      finalRequired: true
    });
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

function resolverFrom(item: ReferencedWorkItem): WorkItemResolver {
  return {
    async resolve() {
      return item;
    }
  };
}

function detailedIssue(issueNumber: number): ReferencedWorkItem {
  return {
    source: "github-issue",
    repository: "example/leanrigor",
    issueNumber,
    title: "Add deterministic test-obligation planning and evidence gates",
    body: [
      "## Problem",
      "Validation evidence exists but a broad suite can miss changed behaviour.",
      "## Goal",
      "Derive explicit test obligations and require completion evidence.",
      "## Desired behaviour",
      "Planning produces phase-specific test obligations based on workflow state, planning, completion evidence gates, validation evidence, and review policy.",
      "## Safety and compatibility",
      "Preserve existing workflow-state compatibility through defaults or migration.",
      "## Acceptance criteria",
      "- Bug-fix plans require regression coverage.",
      "- Completion evidence records obligation IDs and validation results."
    ].join("\n"),
    acceptanceCriteria: [
      "Bug-fix plans require regression coverage.",
      "Completion evidence records obligation IDs and validation results."
    ],
    contentStatus: "resolved",
    truncated: false,
    retrievedAt: "2026-07-28T00:00:00.000Z"
  };
}
