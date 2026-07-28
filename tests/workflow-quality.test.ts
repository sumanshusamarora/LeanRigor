import { describe, expect, it } from "vitest";
import {
  artifactHash,
  classifyPhaseBriefFailure,
  evaluatePhaseBriefQuality,
  identicalDeterministicRetry,
  nextRecoveryStrategy,
  recoveryAttempt
} from "../src/core/workflow-quality.js";
import type {
  ArtifactRecoveryAttempt,
  PhaseBriefDiagnostic,
  PhaseExecutionBrief,
  WorkflowPhase
} from "../src/core/types.js";

describe("artifact quality scoring", () => {
  it("passes a complete artifact across explicit dimensions", () => {
    const quality = evaluatePhaseBriefQuality(brief(), phase(), []);

    expect(quality.overall).toBe("pass");
    expect(Object.keys(quality.dimensions)).toEqual([
      "completeness",
      "specificity",
      "traceability",
      "phase-closure",
      "dependency-validity",
      "evidence-coverage",
      "recovery-viability",
      "internal-consistency"
    ]);
  });

  it("reports a stable warning for a skipped identical retry", () => {
    const candidate = brief();
    candidate.recoveryAttempts = [attempt({ disposition: "skipped-identical", changed: false })];

    expect(evaluatePhaseBriefQuality(candidate, phase(), []).dimensions["recovery-viability"]).toEqual({
      status: "warning",
      diagnosticCodes: ["recovery.identical_retry_skipped"],
      evidence: ["An unchanged deterministic retry was skipped."]
    });
  });

  it("fails non-inspectable acceptance with structured evidence", () => {
    const diagnostic = phaseDiagnostic("acceptanceCriteria", "acceptance.not_inspectable", "Criterion is structural only.");
    const quality = evaluatePhaseBriefQuality(brief(), phase(), [diagnostic]);

    expect(quality.overall).toBe("fail");
    expect(quality.dimensions.traceability).toEqual({
      status: "fail",
      diagnosticCodes: ["acceptance.not_inspectable"],
      evidence: ["Criterion is structural only."]
    });
  });

  it("fails broken dependency closure in its own dimension", () => {
    const diagnostic = phaseDiagnostic("dependencies", "dependency.future", "A later phase is required.");

    expect(evaluatePhaseBriefQuality(brief(), phase(), [diagnostic]).dimensions["dependency-validity"].status).toBe("fail");
  });
});

describe("bounded recovery liveness", () => {
  it("detects an unchanged deterministic retry", () => {
    const previous = attempt();
    expect(identicalDeterministicRetry(previous, {
      strategy: previous.strategy,
      provider: previous.provider,
      modelTier: previous.modelTier,
      inputArtifactHash: previous.inputArtifactHash,
      inspectionIdentity: previous.inspectionIdentity,
      validationDiagnostics: previous.validationDiagnostics
    })).toBe(true);
  });

  it("permits a materially changed strategy", () => {
    const previous = attempt();
    expect(identicalDeterministicRetry(previous, {
      strategy: "alternate-strategy",
      provider: previous.provider,
      modelTier: "large",
      inputArtifactHash: previous.inputArtifactHash,
      inspectionIdentity: previous.inspectionIdentity,
      validationDiagnostics: previous.validationDiagnostics
    })).toBe(false);
  });

  it("records unchanged hashes and advances through configured limits", () => {
    const diagnostics = [phaseDiagnostic("acceptanceCriteria", "acceptance.not_inspectable", "Not observable.")];
    const first = recoveryAttempt({
      attempts: [],
      strategy: "initial-generation",
      provider: "deterministic",
      modelTier: "medium",
      input: { request: "bounded" },
      output: { artifact: "same" },
      inspectionIdentity: "inspection-1",
      diagnostics,
      disposition: "continue"
    });
    const repeated = recoveryAttempt({
      attempts: [first],
      strategy: "initial-generation",
      provider: "deterministic",
      modelTier: "medium",
      input: { request: "bounded" },
      output: { artifact: "same" },
      inspectionIdentity: "inspection-1",
      diagnostics,
      disposition: "skipped-identical"
    });

    expect(repeated.changed).toBe(false);
    expect(repeated.outputArtifactHash).toBe(artifactHash({ artifact: "same" }));
    expect(nextRecoveryStrategy([first], { targeted: 1, refreshedInspection: 1, alternate: 1, fallback: 1 })).toBe("targeted-repair");
    expect(nextRecoveryStrategy([
      first,
      attempt({ strategy: "targeted-repair" }),
      attempt({ strategy: "refreshed-inspection" }),
      attempt({ strategy: "alternate-strategy" }),
      attempt({ strategy: "deterministic-fallback" })
    ], { targeted: 1, refreshedInspection: 1, alternate: 1, fallback: 1 })).toBeUndefined();
  });

  it("classifies generation failures as LeanRigor-owned without revising user scope", () => {
    expect(classifyPhaseBriefFailure("quality-blocked", [
      phaseDiagnostic("acceptanceCriteria", "acceptance.not_inspectable", "Not observable.")
    ])).toBe("leanrigor_generation_failure");
    expect(classifyPhaseBriefFailure("inspection-unavailable", [])).toBe("repository_evidence_insufficient");
  });
});

function phase(): WorkflowPhase {
  return {
    id: "phase-a",
    objective: "Implement a bounded observable change",
    rationale: "The repository remains independently valid.",
    dependencies: [],
    dependsOn: [],
    expectedReadAreas: ["src/change.ts"],
    expectedWriteAreas: ["src/change.ts"],
    expectedFilesOrAreas: ["src/change.ts"],
    acceptanceCriteria: ["A focused test records a passing result."],
    validationCommands: ["npm test"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "planned",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

function brief(): PhaseExecutionBrief {
  return {
    phaseId: "phase-a",
    briefRevision: 1,
    acceptanceCriteria: ["A focused test records a passing result."],
    validationCommands: ["npm test"],
    relevantFiles: ["src/change.ts"],
    relevantSymbols: ["applyChange"],
    writeAreas: ["src/change.ts"],
    dependencies: [],
    testObligations: ["Run a focused regression test."],
    recoveryAttempts: []
  } as unknown as PhaseExecutionBrief;
}

function phaseDiagnostic(field: PhaseBriefDiagnostic["field"], code: string, message: string): PhaseBriefDiagnostic {
  return { stage: "quality", field, code, message, repairAttempt: "none", resolution: "unresolved" };
}

function attempt(overrides: Partial<ArtifactRecoveryAttempt> = {}): ArtifactRecoveryAttempt {
  return {
    attempt: 1,
    strategy: "initial-generation",
    provider: "deterministic",
    modelTier: "medium",
    inputArtifactHash: "input",
    outputArtifactHash: "output",
    inspectionIdentity: "inspection-1",
    validationDiagnostics: ["acceptance.not_inspectable"],
    changed: true,
    disposition: "continue",
    timestamp: "2026-07-28T00:00:00.000Z",
    ...overrides
  };
}
