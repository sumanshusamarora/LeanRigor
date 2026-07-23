import { describe, expect, it } from "vitest";
import { applyPolicyOverrides, assessTask, validateTriageOutput } from "../src/core/assessment.js";
import { defaultConfig } from "../src/config/defaults.js";

function mode(request: string): string {
  return assessTask(request, defaultConfig()).workflow.finalMode;
}

describe("triage assessment", () => {
  it("selects fast only for positively low-risk work", () => {
    const result = assessTask("Fix the typo in the README documentation", defaultConfig());
    expect(result.workflow.finalMode).toBe("fast");
    expect(result.workflow.reviewLevel).toBe("sanity");
    expect(result.workflow.testLevel).toBe("sanity");
  });

  it("selects standard and targeted tests for a bug fix", () => {
    const result = assessTask("Fix the broken assignment API response for existing leads", defaultConfig());
    expect(result.workflow.finalMode).toBe("standard");
    expect(result.workflow.reviewLevel).toBe("integrated");
    expect(result.workflow.testLevel).toBe("targeted");
  });

  it("selects rigorous for an explicit migration trigger", () => {
    const result = assessTask("Add a production database migration for API keys", defaultConfig());
    expect(result.workflow.finalMode).toBe("rigorous");
    expect(result.escalationReasons[0]).toMatch(/trigger/i);
  });

  it("keeps complexity separate from workflow rigor", () => {
    const result = assessTask("Investigate a difficult read-only root cause across multiple packages", defaultConfig());
    expect(result.task.type).toBe("investigation");
    expect(result.workflow.finalMode).toBe("standard");
  });

  it("returns no more than one blocking question", () => {
    const result = assessTask("Fix it", defaultConfig());
    expect(result.clarification.required).toBe(true);
    expect(result.clarification.question).toBeTruthy();
  });

  it("marks parallelism only as a planning candidate", () => {
    const result = assessTask("Implement independent backend and frontend changes in parallel", defaultConfig());
    expect(result.workflow.parallelism).toBe("candidate");
  });

  it("applies deterministic risk overrides to a model recommendation", () => {
    const base = assessTask("Add a normal application feature", defaultConfig());
    const overridden = applyPolicyOverrides({
      ...base,
      assessment: { ...base.assessment, securityRisk: "high" },
      workflow: { ...base.workflow, modelRecommendation: "standard", finalMode: "standard" }
    }, defaultConfig());
    expect(overridden.workflow.finalMode).toBe("rigorous");
    expect(overridden.workflow.overridden).toBe(true);
    expect(overridden.workflow.overrideReason).toMatch(/high-risk/i);
  });

  it("rejects inconsistent clarification output", () => {
    const valid = assessTask("Fix the broken assignment API response", defaultConfig());
    expect(() => validateTriageOutput({
      ...valid,
      clarification: { required: true, question: null, reason: null }
    })).toThrow();
  });

  it("honours a configured mode override", () => {
    const config = defaultConfig();
    config.workflow.defaultMode = "rigorous";
    expect(assessTask("Update README documentation", config).workflow.finalMode).toBe("rigorous");
  });

  it("retains expected core classifications", () => {
    expect(mode("Fix the typo in the README documentation")).toBe("fast");
    expect(mode("Fix the broken assignment API response")).toBe("standard");
    expect(mode("Change authentication token validation")).toBe("rigorous");
  });
});
