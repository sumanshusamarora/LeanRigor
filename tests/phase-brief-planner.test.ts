import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  canonicalRiskCategories,
  classifyPhaseBriefChanges,
  classifyAcceptanceOutcome,
  DeterministicPhaseBriefPlanningProvider,
  generateInspectedPhaseExecutionBrief,
  synthesizeObservableAcceptanceCriteria,
  validatePhaseExecutionBrief,
  type PhaseBriefPlanningProvider,
  type PhaseBriefProposal
} from "../src/core/phase-brief-planner.js";
import type { PhaseExecutionBrief, SequentialWorkflowState, WorkflowPhase } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
let fixture: Awaited<ReturnType<typeof planningFixture>>;
let validBrief: PhaseExecutionBrief;

beforeAll(async () => {
  fixture = await planningFixture();
  const outcome = await generateInspectedPhaseExecutionBrief({
    state: fixture.state,
    phase: fixture.phase,
    config: defaultConfig()
  });
  if (outcome.status !== "generated") throw new Error(JSON.stringify(outcome.failure, null, 2));
  validBrief = outcome.brief;
});

describe("phase execution brief generation", () => {
  it("adds inspected detail, files, symbols, tests, validation, and repository provenance", () => {
    expect(validBrief.deliverable).toContain("src/feature.ts");
    expect(validBrief.implementationApproach.split("\n").length).toBeGreaterThanOrEqual(4);
    expect(validBrief.relevantFiles).toEqual(expect.arrayContaining(["src/feature.ts", "tests/feature.test.ts"]));
    expect(validBrief.relevantSymbols).toEqual(expect.arrayContaining(["src/feature.ts#applyFeature"]));
    expect(validBrief.testObligations.join("\n")).toMatch(/regression|configured check/i);
    expect(validBrief.validationCommands).toEqual(expect.arrayContaining(["npm test", "npm run typecheck"]));
    expect(validBrief.assumptions).toEqual(expect.any(Array));
    expect(validBrief.exclusions).toEqual(expect.any(Array));
    expect(validBrief.risks).not.toEqual([]);
    expect(validBrief.repository).toMatchObject({
      baseCommit: expect.any(String),
      repositoryRevision: expect.any(String),
      constraintHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inspectionResultId: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(validBrief.inspectionResult.provenance.source).toBe("deterministic-bounded-inspection");
    expect(validBrief.validation.status).toBe("valid");
    expect(validBrief.approvalStatus).toBe("pending");
    expect(validBrief.currentBehaviour).not.toBe(fixture.phase.rationale);
  });

  it("incorporates relevant prior phase results into a later brief", async () => {
    const prior = structuredClone(fixture.phase);
    prior.id = "phase-0";
    prior.status = "completed";
    prior.filesChanged = ["src/contract.ts"];
    prior.completedAt = new Date().toISOString();
    prior.completion = {
      phaseId: "phase-0",
      objective: prior.objective,
      decision: "completed",
      reason: "Contract boundary confirmed.",
      criteria: [],
      filesChanged: ["src/contract.ts"],
      validation: { status: "passed", commands: [], skipped: [], missing: [] },
      scopeDeviations: [],
      assumptions: ["The serialized field remains optional."],
      remainingRisks: [],
      dependentPhasesMayProceed: true,
      repairAttempt: 0,
      timestamp: new Date().toISOString(),
      workflowRevision: fixture.state.revision
    };
    const phase = structuredClone(fixture.phase);
    phase.id = "phase-2";
    phase.dependencies = ["phase-0"];
    phase.dependsOn = ["phase-0"];
    const state = structuredClone(fixture.state);
    state.plan!.phases = [prior, phase];

    const outcome = await generateInspectedPhaseExecutionBrief({ state, phase, config: defaultConfig() });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.currentBehaviour).toContain("phase-0");
      expect(outcome.brief.assumptions).toContain("From phase-0: The serialized field remains optional.");
    }
  });

  it("defers release-version gates when a phase cannot write the complete version surface", async () => {
    const phase = structuredClone(fixture.phase);
    phase.validationCommands.push(
      "npm run check:plugin-version-bump",
      "npm run version:dev",
      "npm run version:check"
    );
    const state = structuredClone(fixture.state);
    state.plan!.phases = [phase];

    const outcome = await generateInspectedPhaseExecutionBrief({ state, phase, config: defaultConfig() });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.validationCommands).toContain("npm run version:check");
      expect(outcome.brief.validationCommands).not.toContain("npm run check:plugin-version-bump");
      expect(outcome.brief.validationCommands).not.toContain("npm run version:dev");
    }
  });

  it("fails closed when bounded inspection cannot locate any approved evidence", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "leanrigor-brief-unavailable-"));
    const phase = structuredClone(fixture.phase);
    phase.expectedReadAreas = ["missing/feature.ts"];
    phase.expectedWriteAreas = ["missing/feature.ts"];
    phase.expectedFilesOrAreas = ["missing/feature.ts"];
    const state = structuredClone(fixture.state);
    state.root = emptyRoot;
    state.plan!.phases = [phase];
    const config = defaultConfig();
    config.budgets.phaseBriefInspectionMaxReads = 1;
    const outcome = await generateInspectedPhaseExecutionBrief({ state, phase, config });

    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.failure.status).toBe("inspection-unavailable");
      expect(outcome.failure.diagnostics).not.toEqual([]);
    }
  });
});

describe("phase brief deterministic quality", () => {
  it.each([
    ["copied synthetic phase", (brief: PhaseExecutionBrief) => {
      brief.deliverable = fixture.phase.rationale;
      brief.currentBehaviour = fixture.phase.rationale;
      brief.implementationApproach = fixture.phase.rationale;
      brief.relevantFiles = [];
      brief.relevantSymbols = [];
    }, /synthetic_copy|not_concrete|not_actionable/],
    ["generic implementation approach", (brief: PhaseExecutionBrief) => { brief.implementationApproach = "update relevant files"; }, /approach.not_actionable/],
    ["missing write boundary", (brief: PhaseExecutionBrief) => { brief.writeAreas = []; }, /scope.missing_write_boundary/],
    ["missing acceptance criteria", (brief: PhaseExecutionBrief) => { brief.acceptanceCriteria = []; }, /acceptance.missing/],
    ["missing validation", (brief: PhaseExecutionBrief) => {
      brief.validationCommands = [];
      brief.manualValidationPlan = undefined;
    }, /validation.missing/],
    ["missing tests", (brief: PhaseExecutionBrief) => { brief.testObligations = []; }, /tests.missing/]
  ])("rejects %s", (_name, mutate, expected) => {
    const brief = structuredClone(validBrief);
    mutate(brief);
    expect(validatePhaseExecutionBrief(brief, fixture.phase).map((item) => item.code).join("\n")).toMatch(expected);
  });

  it("rejects a brief that requires test writes without approving a test write path", () => {
    const brief = structuredClone(validBrief);
    brief.writeAreas = brief.writeAreas.filter((area) => !area.startsWith("tests"));
    brief.testObligations = ["Add focused regression tests for the changed behavior."];

    expect(validatePhaseExecutionBrief(brief, fixture.phase)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "writeAreas", code: "tests.missing_write_boundary" })
    ]));
  });

  it("does not require implementation write areas or unit tests for documentation-only work", () => {
    const phase = structuredClone(fixture.phase);
    phase.objective = "Update README documentation for the feature contract.";
    phase.rationale = "Documentation-only clarification.";
    phase.expectedReadAreas = ["README.md"];
    phase.expectedWriteAreas = ["README.md"];
    phase.expectedFilesOrAreas = ["README.md"];
    const brief = structuredClone(validBrief);
    brief.objective = phase.objective;
    brief.writeAreas = [];
    brief.readAreas = ["README.md"];
    brief.relevantFiles = ["README.md"];
    brief.relevantSymbols = [];
    brief.deliverable = "README.md documents the observable feature contract and verified example.";
    brief.implementationApproach = "1. Inspect README.md examples.\n2. Update README.md contract wording.\n3. Verify README.md links and rendered structure.";
    brief.testObligations = ["Verify documentation links, examples, and rendered structure."];
    brief.validationCommands = [];
    brief.manualValidationPlan = "Review README.md links, headings, examples, and rendered formatting.";

    expect(validatePhaseExecutionBrief(brief, phase)).toEqual([]);
  });

  it("accepts a detailed inspected brief", () => {
    expect(validatePhaseExecutionBrief(validBrief, fixture.phase)).toEqual([]);
  });
});

describe("generic acceptance synthesis", () => {
  it.each([
    ["A persisted record has an identifier and required fields.", "persistence", /round-trip check saves and reloads/i],
    ["Previously persisted state remains compatible.", "compatibility", /compatibility check loads/i],
    ["The public interface has an optional field.", "schema", /schema or type-contract check accepts/i],
    ["The command-line option exists.", "cli", /command invocation records its exit code/i]
  ])("turns a structural %s requirement into observable evidence", (criterion, category, expected) => {
    expect(classifyAcceptanceOutcome(criterion)).toBe(category);
    expect(synthesizeObservableAcceptanceCriteria([criterion], { validationCommands: ["npm test"] })[0]).toMatch(expected);
  });

  it("preserves already observable criteria", () => {
    const criterion = "A compatibility test loads previously persisted state and npm test passes.";
    expect(synthesizeObservableAcceptanceCriteria([criterion], { validationCommands: ["npm test"] })).toEqual([criterion]);
  });

  it("contains no canary-specific entity names", () => {
    const fallback = synthesizeObservableAcceptanceCriteria([
      "The stored schema has a stable identifier.",
      "Previously persisted state remains compatible."
    ]).join("\n");
    expect(fallback).not.toMatch(/TestObligation|issue\s*#?12/i);
  });

  it("treats obligation-planning language as a workflow rule rather than a domain migration", () => {
    const [synthesized] = synthesizeObservableAcceptanceCriteria([
      "Planning rules require relevant migration and compatibility obligations."
    ], { validationCommands: ["npm test"] });

    expect(synthesized).toMatch(/focused repository check/i);
    expect(synthesized).not.toMatch(/rollback|previously persisted state/i);
  });

  it("classifies loadable existing artifacts as compatibility evidence", () => {
    expect(classifyAcceptanceOutcome("Existing workflows remain loadable.")).toBe("compatibility");
    expect(synthesizeObservableAcceptanceCriteria(["Existing workflows remain loadable."])[0]).toMatch(/compatibility check loads/i);
  });

  it("classifies missing-required behavior as a failure path before structural schema terms", () => {
    expect(classifyAcceptanceOutcome("Missing required evidence prevents completion.")).toBe("failure-handling");
  });

  it("treats synthesized evidence as a non-material traceability refinement", () => {
    const phase = structuredClone(fixture.phase);
    phase.acceptanceCriteria = ["The public interface has an optional field."];
    const candidate = proposal(validBrief);
    candidate.acceptanceCriteria = synthesizeObservableAcceptanceCriteria(phase.acceptanceCriteria, {
      validationCommands: phase.validationCommands
    });

    expect(classifyPhaseBriefChanges(phase, candidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "acceptance-criteria", material: false })
    ]));
  });
});

describe("phase brief repair", () => {
  it("passes exact diagnostics to same-provider repair, preserves valid fields, and increments revision", async () => {
    const baseline = proposal(validBrief);
    const originalObjective = baseline.objective;
    const seen: string[] = [];
    const provider: PhaseBriefPlanningProvider = {
      name: "repair-test-provider",
      async generate() {
        return { provider: this.name, modelTier: "medium", proposal: { ...baseline, implementationApproach: "implement the feature" } };
      },
      async repair(_input, request) {
        seen.push(...request.diagnostics.map((item) => item.code));
        return {
          provider: this.name,
          modelTier: "medium",
          proposal: {
            ...baseline,
            objective: "This valid field must not replace the original objective.",
            implementationApproach: validBrief.implementationApproach
          }
        };
      }
    };

    const outcome = await generateInspectedPhaseExecutionBrief({
      state: fixture.state,
      phase: fixture.phase,
      config: defaultConfig(),
      provider
    });

    expect(seen).toContain("approach.not_actionable");
    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.objective).toBe(originalObjective);
      expect(outcome.brief.briefRevision).toBe(2);
      expect(outcome.brief.validation.repairAttempts).toBe(1);
      expect(outcome.brief.validation.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "approach.not_actionable", resolution: "repaired" })
      ]));
    }
  });

  it("advances from an unrepaired provider brief to a deterministic fallback", async () => {
    const baseline = proposal(validBrief);
    const provider: PhaseBriefPlanningProvider = {
      name: "unrepaired-provider",
      async generate() {
        return { provider: this.name, modelTier: "medium", proposal: { ...baseline, implementationApproach: "implement the feature" } };
      },
      async repair() {
        return { provider: this.name, modelTier: "medium", proposal: { ...baseline, implementationApproach: "update relevant files" } };
      }
    };

    const config = defaultConfig();
    config.budgets.phaseBriefDeterministicFallbackAttempts = 1;
    const outcome = await generateInspectedPhaseExecutionBrief({
      state: fixture.state,
      phase: fixture.phase,
      config,
      provider
    });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.deterministicallySynthesized).toBe(true);
      expect(outcome.brief.approvalStatus).toBe("pending");
      expect(outcome.brief.validation.status).toBe("valid");
      expect(outcome.brief.recoveryAttempts?.map((attempt) => attempt.strategy)).toEqual([
        "initial-generation",
        "targeted-repair",
        "refreshed-inspection",
        "alternate-strategy",
        "deterministic-fallback"
      ]);
      expect(outcome.brief.recoveryAttempts?.find((attempt) => attempt.strategy === "refreshed-inspection"))
        .toEqual(expect.objectContaining({ disposition: "skipped-identical" }));
      expect(outcome.brief.recoveryAttempts?.at(-1)).toEqual(expect.objectContaining({
        changed: true,
        disposition: "succeeded"
      }));
    }
  });

  it("uses a bounded alternative strategy before deterministic fallback", async () => {
    const baseline = proposal(validBrief);
    const provider: PhaseBriefPlanningProvider = {
      name: "alternate-provider",
      async generate() {
        return { provider: this.name, modelTier: "medium", proposal: { ...baseline, implementationApproach: "implement the feature" } };
      },
      async repair() {
        return { provider: this.name, modelTier: "medium", proposal: { ...baseline, implementationApproach: "update relevant files" } };
      },
      async alternate() {
        return { provider: this.name, modelTier: "large", proposal: baseline };
      }
    };

    const outcome = await generateInspectedPhaseExecutionBrief({
      state: fixture.state,
      phase: fixture.phase,
      config: defaultConfig(),
      provider
    });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.deterministicallySynthesized).not.toBe(true);
      expect(outcome.brief.recoveryAttempts?.map((attempt) => attempt.strategy)).toEqual([
        "initial-generation",
        "targeted-repair",
        "refreshed-inspection",
        "alternate-strategy"
      ]);
      expect(outcome.brief.recoveryAttempts?.at(-1)).toEqual(expect.objectContaining({
        modelTier: "large",
        disposition: "succeeded"
      }));
    }
  });
});

describe("phase brief material changes", () => {
  it("classifies exact file and symbol refinement inside the approved boundary as non-material", () => {
    const phase = structuredClone(fixture.phase);
    phase.expectedWriteAreas = ["src"];
    const candidate = proposal(validBrief);
    candidate.writeAreas = ["src/feature.ts"];
    candidate.relevantSymbols = ["src/feature.ts#applyFeature"];
    const changes = classifyPhaseBriefChanges(phase, candidate);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "file-refinement", material: false }),
      expect.objectContaining({ category: "symbol-refinement", material: false })
    ]));
    expect(changes.filter((change) => change.category === "write-boundary")).toEqual([]);
  });

  it("classifies a bounded test root required by test obligations as non-material verification support", () => {
    const phase = structuredClone(fixture.phase);
    phase.expectedWriteAreas = ["src/feature.ts"];
    phase.expectedFilesOrAreas = ["src/feature.ts"];
    const candidate = proposal(validBrief);
    candidate.writeAreas = ["src/feature.ts", "tests/**"];
    candidate.testObligations = ["Add focused regression tests for the changed behavior."];

    const changes = classifyPhaseBriefChanges(phase, candidate);

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "file-refinement",
        proposedValue: ["tests/**"],
        material: false,
        requiredTransition: "none"
      })
    ]));
    expect(changes.filter((change) => change.category === "write-boundary")).toEqual([]);
  });

  it.each([
    ["new write boundary", (candidate: PhaseBriefProposal) => { candidate.writeAreas = ["outside/new.ts"]; }, "write-boundary"],
    ["changed acceptance criterion", (candidate: PhaseBriefProposal) => { candidate.acceptanceCriteria = ["A different observable outcome is accepted."]; }, "acceptance-criteria"],
    ["new dependency", (candidate: PhaseBriefProposal) => { candidate.dependencies = ["phase-x"]; }, "dependency"]
  ])("flags %s as material", (_name, mutate, category) => {
    const candidate = proposal(validBrief);
    mutate(candidate);
    expect(classifyPhaseBriefChanges(fixture.phase, candidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category, material: true })
    ]));
  });

  it("does not treat issue 13 credential requirements as inspection discoveries", async () => {
    const state = structuredClone(fixture.state);
    state.request = "Show model and provider provenance for each workflow stage without exposing prompts, secrets, credentials, or unrestricted provider diagnostics.";
    state.plan!.summary = "Persist and render provider provenance.";
    state.plan!.principles = ["Keep the architecture provider-neutral."];

    const outcome = await generateInspectedPhaseExecutionBrief({
      state,
      phase: state.plan!.phases[0]!,
      config: defaultConfig()
    });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.risks).toContain("Security-sensitive behaviour must preserve authentication, authorization, and credential boundaries.");
      expect(outcome.brief.riskDiscoveries).toEqual([]);
      expect(outcome.brief.materialChangesFromWorkflowPlan.filter((change) => change.category === "risk")).toEqual([]);
    }
  });

  it.each([
    ["request", (state: SequentialWorkflowState) => { state.request += " Preserve credential boundaries."; }],
    ["plan summary", (state: SequentialWorkflowState) => { state.plan!.summary += " Preserve credential boundaries."; }],
    ["plan principles", (state: SequentialWorkflowState) => { state.plan!.principles.push("Preserve credential boundaries."); }],
    ["phase objective", (_state: SequentialWorkflowState, phase: WorkflowPhase) => { phase.objective += " Preserve credential boundaries."; }],
    ["phase rationale", (_state: SequentialWorkflowState, phase: WorkflowPhase) => { phase.rationale += " Preserve credential boundaries."; }],
    ["acceptance criteria", (_state: SequentialWorkflowState, phase: WorkflowPhase) => { phase.acceptanceCriteria.push("Credential boundaries remain unchanged."); }],
    ["validation requirements", (_state: SequentialWorkflowState, phase: WorkflowPhase) => { phase.validationCommands.push("npm run credential-check"); }],
    ["effective constraints", (state: SequentialWorkflowState) => {
      state.constraints = {
        original: [],
        policy: [],
        userAdditions: [],
        userRemovals: [],
        userOverrides: [],
        effective: [{
          id: "constraint-security",
          text: "Preserve credential boundaries.",
          source: "user",
          createdAt: new Date(0).toISOString(),
          workflowRevision: state.revision,
          transition: "approved"
        }],
        audit: []
      };
    }],
    ["approved assumptions", (state: SequentialWorkflowState) => { state.triage!.assumptions.push("Credential boundaries are unchanged."); }]
  ])("does not classify a risk already present in approved %s as new", async (_source, addApprovedContext) => {
    const state = structuredClone(fixture.state);
    const phase = structuredClone(fixture.phase);
    addApprovedContext(state, phase);
    state.plan!.phases = [phase];
    const provider = inspectionDiscoveryProvider("Inspection found a security-sensitive credential boundary.");

    const outcome = await generateInspectedPhaseExecutionBrief({ state, phase, config: defaultConfig(), provider });

    expect(outcome.status).toBe("generated");
    if (outcome.status === "generated") {
      expect(outcome.brief.riskDiscoveries).toEqual([
        expect.objectContaining({ source: "inspection", categories: ["security"] })
      ]);
      expect(outcome.brief.materialChangesFromWorkflowPlan.filter((change) => change.category === "risk")).toEqual([]);
    }
  });

  it.each([
    ["credentials and permissions", "security"],
    ["authentication and authorization", "security"],
    ["public API compatibility", "public-contract"],
    ["persisted schema migration", "migration"],
    ["architectural component ownership", "architecture"],
    ["data corruption and data loss", "data-integrity"],
    ["race condition and locking", "concurrency"],
    ["idempotent rollback recovery", "recovery"],
    ["production deployment infrastructure", "production-infrastructure"],
    ["destructive delete operation", "destructive-operation"],
    ["outbound network service", "network-operation"]
  ])("canonicalizes %s as %s", (risk, category) => {
    expect(canonicalRiskCategories(risk)).toContain(category);
  });

  it("makes a genuine inspection-origin discovery material and requires plan revision", () => {
    const candidate = proposal(validBrief);
    candidate.riskDiscoveries = [{
      risk: "Inspection found an architectural ownership boundary outside the approved component.",
      categories: ["architecture"],
      evidence: ["src/feature.ts imports an owner outside the approved boundary."],
      source: "inspection"
    }];

    expect(classifyPhaseBriefChanges(fixture.phase, candidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "risk",
        material: true,
        requiredTransition: "revise-plan",
        reason: expect.stringContaining("architecture")
      })
    ]));
  });

  it("handles known and new risk categories independently", () => {
    const candidate = proposal(validBrief);
    candidate.riskDiscoveries = [{
      risk: "Inspection found a security-sensitive architectural ownership boundary.",
      categories: ["security", "architecture"],
      evidence: ["src/feature.ts crosses the component ownership boundary."],
      source: "inspection"
    }];

    const riskChanges = classifyPhaseBriefChanges(fixture.phase, candidate, ["Authentication and credential handling are approved."])
      .filter((change) => change.category === "risk");

    expect(riskChanges).toHaveLength(1);
    expect(riskChanges[0]).toMatchObject({
      material: true,
      requiredTransition: "revise-plan",
      reason: expect.stringContaining("architecture")
    });
  });
});

function inspectionDiscoveryProvider(risk: string): PhaseBriefPlanningProvider {
  const baseline = new DeterministicPhaseBriefPlanningProvider();
  return {
    name: "inspection-discovery-test",
    async generate(input) {
      const result = await baseline.generate(input);
      result.proposal.risks = [...result.proposal.risks, risk];
      result.proposal.riskDiscoveries = [{
        risk,
        categories: canonicalRiskCategories(risk),
        evidence: ["Bounded repository inspection evidence."],
        source: "inspection"
      }];
      return { ...result, provider: "inspection-discovery-test" };
    }
  };
}

async function planningFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-brief-planner-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "src", "feature.ts"), [
    "export interface FeatureInput { enabled: boolean }",
    "export function applyFeature(input: FeatureInput): boolean {",
    "  return input.enabled;",
    "}"
  ].join("\n"));
  await writeFile(path.join(root, "tests", "feature.test.ts"), "export const featureRegression = true;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
  await writeFile(path.join(root, "README.md"), "# Feature\n");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Brief Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "brief@example.test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  const phase: WorkflowPhase = {
    id: "phase-1",
    objective: "Preserve typed feature evaluation for enabled and disabled inputs.",
    rationale: "A bounded regression affects the existing feature evaluation contract.",
    dependencies: [],
    dependsOn: [],
    expectedReadAreas: ["src/feature.ts", "tests/feature.test.ts"],
    expectedWriteAreas: ["src/feature.ts", "tests/feature.test.ts"],
    expectedFilesOrAreas: ["src/feature.ts", "tests/feature.test.ts"],
    acceptanceCriteria: [
      "Feature evaluation returns true for enabled input and false for disabled input.",
      "The existing FeatureInput contract remains loadable by TypeScript."
    ],
    validationCommands: ["npm test", "npm run typecheck"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "ready",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
  const state = {
    id: "lr-planner-test",
    version: 2,
    revision: 7,
    root,
    request: "Fix the typed feature regression in src/feature.ts and tests/feature.test.ts.",
    mode: "rigorous",
    state: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    blockers: [],
    events: [],
    validation: [],
    repairAttempts: 0,
    phaseLeases: {},
    execution: { records: {} },
    plan: { version: 1, summary: "Fix feature regression.", principles: [], phases: [phase], revisionRequests: [] },
    approval: { policy: "phase-by-phase", workflowPlanRevision: 7, history: [], decisionHistory: [] },
    triage: {
      task: { type: "bug", summary: "Feature regression." },
      assumptions: ["The public FeatureInput shape remains unchanged."],
      constraints: { mustNot: ["Do not change unrelated modules."] }
    }
  } as unknown as SequentialWorkflowState;
  return { root, phase, state };
}

function proposal(brief: PhaseExecutionBrief): PhaseBriefProposal {
  return {
    objective: brief.objective,
    deliverable: brief.deliverable,
    currentBehaviour: brief.currentBehaviour ?? "",
    implementationApproach: brief.implementationApproach,
    readAreas: [...brief.readAreas],
    writeAreas: [...brief.writeAreas],
    relevantFiles: [...brief.relevantFiles],
    relevantSymbols: [...brief.relevantSymbols],
    dependencies: [...brief.dependencies],
    assumptions: [...brief.assumptions],
    exclusions: [...brief.exclusions],
    acceptanceCriteria: [...brief.acceptanceCriteria],
    testObligations: [...brief.testObligations],
    validationCommands: [...brief.validationCommands],
    manualValidationPlan: brief.manualValidationPlan,
    risks: [...brief.risks],
    riskDiscoveries: structuredClone(brief.riskDiscoveries ?? [])
  };
}
