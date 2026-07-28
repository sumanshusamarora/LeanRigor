import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  answerClarification,
  approvePhase,
  approveApproach,
  approvePlan,
  cancelFlow,
  classifyFilePath,
  completeFlow,
  completePhase,
  getCommitPlan,
  getEvidenceTemplate,
  listFlows,
  loadFlowState,
  repairPhase,
  recordReview,
  recordValidation,
  preparePhaseExecutionBrief,
  rejectApproach,
  resumeFlow,
  revisePlan,
  saveFlowState,
  startFlow,
  startPhase,
  validatePlanQuality
} from "../src/core/flow.js";
import type { PlanningProvider } from "../src/core/planning-runner.js";
import type { TriageProvider } from "../src/core/triage-runner.js";
import type { CriterionCompletionEvidence, ModelTriageRecommendation, SequentialWorkflowState, ValidationEvidence, WorkflowPhase } from "../src/core/types.js";
import { workflowNextSummary } from "../src/core/ux.js";
import recoveredRejectedPlan from "./fixtures/recovered-rejected-plan.json" with { type: "json" };

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-flow-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      build: "tsc -p tsconfig.build.json"
    }
  }));
  return root;
}

function planningProviderFrom(values: unknown[], warnings: string[] = []): PlanningProvider {
  let index = 0;
  return {
    name: "fake-planner",
    async plan() {
      const raw = values[Math.min(index, values.length - 1)];
      index += 1;
      return { raw, provider: "fake-planner", model: "planner-test-model", warnings };
    }
  };
}

function planningProviderWithRepair(args: {
  plan: unknown;
  repair?: unknown | Error;
  model?: string;
  onPlan?: () => void;
  onRepair?: (request: Parameters<NonNullable<PlanningProvider["repair"]>>[1]) => void;
}): PlanningProvider {
  return {
    name: "fake-planner",
    async plan() {
      args.onPlan?.();
      return { raw: args.plan, provider: "fake-planner", model: args.model ?? "planner-test-model", tier: "medium" };
    },
    async repair(_input, request) {
      args.onRepair?.(request);
      if (args.repair instanceof Error) throw args.repair;
      return { raw: args.repair ?? args.plan, provider: "fake-planner", model: args.model ?? "planner-test-model", tier: "medium" };
    }
  };
}

function compactPlan(objective = "Implement issue-specific test obligation planning."): unknown {
  return {
    version: 1,
    summary: "Model-generated plan with repository-specific test obligation phases.",
    principles: ["Use model-derived phase boundaries.", "Record specific test obligation evidence."],
    phases: [{
      id: "phase-1",
      objective,
      rationale: "The obligation planner should be reviewed separately from evidence gate enforcement.",
      dependencies: [],
      expectedReadAreas: ["src/core/flow.ts", "src/core/types.ts", "tests/flow.test.ts"],
      expectedWriteAreas: ["src/core/flow.ts", "src/core/types.ts", "tests/flow.test.ts"],
      expectedFilesOrAreas: ["src/core/flow.ts", "src/core/types.ts", "tests/flow.test.ts"],
      acceptanceCriteria: ["Planned changes derive explicit test obligations.", "Mandatory obligation evidence is persisted and enforced."],
      validationCommands: ["npm test", "npm run typecheck"],
      riskLevel: "medium",
      modelTier: "medium"
    }],
    revisionRequests: []
  };
}

describe("sequential workflow orchestration", () => {
  it("creates a persisted workflow with triage and an ID", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    expect(state.id).toMatch(/^lr-/);
    expect(state.mode).toBe("fast");
    expect(state.triageRun?.source).toBe("deterministic-fallback");
    await expect(readFile(path.join(root, ".leanrigor", "workflows", `${state.id}.json`), "utf8")).resolves.toContain(state.request);
  });

  it("supports at most one blocking clarification and persists the answer", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "fix", root, config: defaultConfig() });

    expect(state.state).toBe("awaiting_clarification");
    expect(state.clarification?.question).toBe("What specific behaviour or outcome should change?");
    expect(workflowNextSummary(state)).toMatchObject({
      label: "Clarification",
      pendingAction: "What specific behaviour or outcome should change?",
      summary: {
        question: "What specific behaviour or outcome should change?"
      }
    });

    const answered = await answerClarification({
      root,
      workflowId: state.id,
      answer: "Fix the broken login redirect after successful authentication.",
      config: defaultConfig()
    });

    expect(answered.clarification?.answer).toMatch(/login redirect/);
    expect(answered.triage?.clarification.required).toBe(false);
    expect(answered.state).toBe("awaiting_approach_approval");
  });

  it("skips unnecessary approach approval for obvious Fast work", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    expect(state.mode).toBe("fast");
    expect(state.approach?.required).toBe(false);
    expect(state.state).toBe("awaiting_plan_approval");
    expect(state.plan?.phases).toHaveLength(1);
  });

  it("requires plan approval for Standard work after approach approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    expect(started.mode).toBe("standard");
    expect(started.state).toBe("awaiting_approach_approval");

    const planned = await approveApproach(root, started.id);
    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.plan?.phases).toHaveLength(2);
    const approval = workflowNextSummary(planned);
    expect(approval.summary).toMatchObject({
      workflow: {
        id: planned.id,
        mode: "standard",
        phases: 2
      },
      overallStrategy: {
        implementationDivision: expect.stringContaining("Sequential plan")
      },
      executionStructure: {
        dependencies: [
          { phase: "phase-1", dependsOn: [] },
          { phase: "phase-2", dependsOn: ["phase-1"] }
        ],
        outOfOrderExecution: expect.any(String)
      },
      validationStrategy: {
        finalIntegratedChecks: expect.arrayContaining(["npm test", "npm run typecheck", "npm run lint", "git diff --check"])
      },
      execution: {
        mode: "coordinator-managed",
        workspace: "isolated Git worktree outside the main checkout",
        mainWorkingTree: "remains untouched",
        implementationStarted: false
      }
    });
    expect(approval.approvalActions?.map((action) => action.label)).toEqual([
      "Approve all remaining phases",
      "Approve this phase only",
      "Revise plan",
      "View full details",
      "Cancel workflow"
    ]);
  });

  it("persists a deterministic Standard approval recommendation and records a user override", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Update an internal assignment validation rule", root, config: defaultConfig() });
    const planned = started.state === "awaiting_approach_approval"
      ? await approveApproach(root, started.id, defaultConfig())
      : started;
    const state = await loadFlowState(root, planned.id);
    state.mode = "standard";
    state.request = "Update an internal assignment validation rule";
    state.triage!.assumptions = [];
    state.triage!.assessment = { ...state.triage!.assessment, ambiguity: "low", blastRadius: "low", securityRisk: "none", dataIntegrityRisk: "none", operationalRisk: "none" };
    state.approval = undefined;
    await saveFlowState(root, state, { expectedRevision: state.revision });

    const recommendation = workflowNextSummary(await loadFlowState(root, state.id)).summary.approval as { recommendation: { option: string } };
    expect(recommendation.recommendation.option).toBe("approve-all-remaining");

    const approved = await approvePlan(root, state.id, undefined, "phase-by-phase");
    expect(approved.approval).toMatchObject({ policy: "phase-by-phase", source: "user" });
    expect(approved.approval?.history.at(-1)).toMatchObject({ action: "plan-approved", recommendationOverridden: true });
  });

  it("requires a current exact phase brief revision for phase-by-phase authorization", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());
    const executing = await approvePlan(root, planned.id, undefined, "phase-by-phase");
    const first = executing.plan!.phases[0]!;
    expect(executing.phaseBriefs?.[first.id]).toMatchObject({ phaseId: first.id, approvalStatus: "approved", objective: first.objective, acceptanceCriteria: first.acceptanceCriteria });

    const stale = await loadFlowState(root, executing.id);
    stale.phaseBriefs![first.id]!.workflowRevision -= 1;
    await saveFlowState(root, stale, { expectedRevision: stale.revision });
    await expect(approvePhase({ root, workflowId: stale.id, phaseId: first.id, briefRevision: stale.phaseBriefs![first.id]!.briefRevision })).rejects.toThrow(/no current execution brief/i);
  });

  it("generates a persisted execution brief before later phase authorization", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());
    const executing = await approvePlan(root, planned.id, undefined, "phase-by-phase");
    const state = await loadFlowState(root, executing.id);
    const [first, second] = state.plan!.phases;
    first!.status = "completed";
    second!.status = "planned";
    state.approval!.currentAuthorizedPhase = undefined;
    await saveFlowState(root, state, { expectedRevision: state.revision });

    const briefed = await preparePhaseExecutionBrief({ root, workflowId: state.id, phaseId: second!.id });
    const brief = briefed.phaseBriefs?.[second!.id];
    expect(brief).toMatchObject({ phaseId: second!.id, objective: second!.objective, deliverable: expect.any(String), approvalStatus: "pending" });
    const approved = await approvePhase({ root, workflowId: state.id, phaseId: second!.id, briefRevision: brief!.briefRevision });
    expect(approved.approval?.currentAuthorizedPhase).toBe(second!.id);
  });

  it("uses model-backed planning after approach approval when a provider is available", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([compactPlan()]),
      providerSelection: "auto"
    });

    expect(planned.planningRun).toMatchObject({
      source: "model",
      provider: "fake-planner",
      model: "planner-test-model",
      attempts: 1
    });
    expect(planned.plan?.phases).toHaveLength(1);
    expect(planned.plan?.phases[0]?.objective).toBe("Implement issue-specific test obligation planning.");
    expect(planned.plan?.phases[0]?.status).toBe("planned");
  });

  it("persists approval constraint additions and removals before planning", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const legacy = await loadFlowState(root, started.id);
    legacy.triage!.constraints.mustNot = ["Preserve backward compatibility"];
    legacy.constraints = undefined;
    await saveFlowState(root, legacy, { expectedRevision: legacy.revision });
    let observedConstraints: string[] = [];
    let observedConstraintSet: unknown;

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: {
        name: "capturing-planner",
        async plan(input) {
          observedConstraints = input.effectiveConstraints ?? [];
          observedConstraintSet = input.effectiveConstraintSet;
          return { raw: compactPlan("Implement the approved API behavior without compatibility constraints."), provider: "capturing-planner" };
        }
      },
      providerSelection: "auto"
    }, {
      remove: ["Preserve backward compatibility"],
      add: ["Backward compatibility is not required for this workflow", "Tests must be updated", "All checks must pass"]
    });

    expect(planned.constraints?.original.map((constraint) => constraint.text)).toEqual(["Preserve backward compatibility"]);
    expect(planned.constraints?.userRemovals.map((change) => change.text)).toEqual(["Preserve backward compatibility"]);
    expect(planned.constraints?.effective.map((constraint) => constraint.text)).toEqual([
      "Backward compatibility is not required for this workflow",
      "Tests must be updated",
      "All checks must pass"
    ]);
    expect(observedConstraints).toEqual(planned.constraints?.effective.map((constraint) => constraint.text));
    expect(observedConstraintSet).toMatchObject({
      triage: ["Preserve backward compatibility"],
      userRemovals: [{ text: "Preserve backward compatibility" }],
      userAdditions: [
        "Backward compatibility is not required for this workflow",
        "Tests must be updated",
        "All checks must pass"
      ],
      finalEffective: [
        "Backward compatibility is not required for this workflow",
        "Tests must be updated",
        "All checks must pass"
      ]
    });
    expect(workflowNextSummary(planned).summary).toMatchObject({
      approvedConstraints: expect.arrayContaining([
        { text: "Tests must be updated", source: "user" },
        { text: "All checks must pass", source: "user" }
      ]),
      execution: { provider: "auto", workspace: "isolated Git worktree outside the main checkout", manualExecution: "not selected", implementationStarted: false }
    });
  });

  it("treats an approved compatibility waiver as authoritative over triage compatibility requirements", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const legacy = await loadFlowState(root, started.id);
    legacy.triage!.constraints.mustNot = ["Preserve backward compatibility"];
    legacy.constraints = undefined;
    await saveFlowState(root, legacy, { expectedRevision: legacy.revision });
    let observedConstraintSet: unknown;

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: {
        name: "capturing-planner",
        async plan(input) {
          observedConstraintSet = input.effectiveConstraintSet;
          return { raw: compactPlan("Implement the approved API behavior with required tests."), provider: "capturing-planner" };
        }
      },
      providerSelection: "auto"
    }, {
      add: ["Backward compatibility is not required for this workflow", "Tests must be updated", "All checks must pass"]
    });

    expect(planned.constraints?.original.map((constraint) => constraint.text)).toEqual(["Preserve backward compatibility"]);
    expect(planned.constraints?.effective.map((constraint) => constraint.text)).toEqual([
      "Backward compatibility is not required for this workflow",
      "Tests must be updated",
      "All checks must pass"
    ]);
    expect(observedConstraintSet).toMatchObject({
      triage: ["Preserve backward compatibility"],
      userAdditions: [
        "Backward compatibility is not required for this workflow",
        "Tests must be updated",
        "All checks must pass"
      ],
      finalEffective: [
        "Backward compatibility is not required for this workflow",
        "Tests must be updated",
        "All checks must pass"
      ]
    });
  });

  it("does not allow user removals to delete policy-owned mandatory constraints", async () => {
    const root = await tempRepo();
    const config = { ...defaultConfig(), instructions: ["Completion evidence is mandatory."] };
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config });

    const planned = await approveApproach(root, started.id, config, undefined, {
      provider: planningProviderFrom([compactPlan("Implement behavior with completion evidence gates.")]),
      providerSelection: "auto"
    }, {
      remove: ["Completion evidence is mandatory."]
    });

    expect(planned.constraints?.policy.map((constraint) => constraint.text)).toEqual(["Completion evidence is mandatory."]);
    expect(planned.constraints?.effective.map((constraint) => constraint.text)).toContain("Completion evidence is mandatory.");
  });

  it("rejects user compatibility waivers that contradict policy-owned compatibility requirements", async () => {
    const root = await tempRepo();
    const config = { ...defaultConfig(), instructions: ["Preserve backward compatibility."] };
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config });

    await expect(approveApproach(root, started.id, config, undefined, {
      provider: planningProviderFrom([compactPlan("Implement the approved API behavior with tests.")]),
      providerSelection: "auto"
    }, {
      add: ["Backward compatibility is not required for this workflow"]
    })).rejects.toThrow(/policy-owned constraint\(s\) still require it/i);
  });

  it("passes the structured effective constraint set to plan revision and repair", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([compactPlan("Implement the approved API behavior with tests.")]),
      providerSelection: "auto"
    }, {
      add: ["Backward compatibility is not required", "Tests must be updated", "All checks must pass"]
    });
    let plannedConstraintSet: unknown;
    let repairConstraintSet: unknown;
    const contradictory = compactPlan("Implement the backward-compatible API behavior.") as Record<string, unknown>;
    (contradictory.phases as Array<Record<string, unknown>>)[0]!.rationale = "This phase performs a backward-compatible migration.";
    const repaired = compactPlan("Implement the approved API behavior with required tests.");

    const revised = await revisePlan(root, planned.id, "Keep the plan narrow.", defaultConfig(), undefined, {
      provider: {
        name: "capturing-revision-planner",
        async plan(input) {
          plannedConstraintSet = input.effectiveConstraintSet;
          return { raw: contradictory, provider: "capturing-revision-planner", model: "planner-test-model" };
        },
        async repair(input) {
          repairConstraintSet = input.effectiveConstraintSet;
          return { raw: repaired, provider: "capturing-revision-planner", model: "planner-test-model" };
        }
      },
      providerSelection: "auto"
    });

    expect(revised.state).toBe("awaiting_plan_approval");
    expect(plannedConstraintSet).toMatchObject({
      userAdditions: ["Backward compatibility is not required", "Tests must be updated", "All checks must pass"],
      finalEffective: expect.arrayContaining(["Backward compatibility is not required", "Tests must be updated", "All checks must pass"])
    });
    expect(repairConstraintSet).toEqual(plannedConstraintSet);
  });

  it("blocks approval when a model plan contradicts an approved compatibility override and repair fails", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const contradictory = compactPlan("Implement the backward-compatible API behavior.") as Record<string, unknown>;
    (contradictory.phases as Array<Record<string, unknown>>)[0]!.rationale = "This phase preserves backward compatibility.";

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([contradictory]),
      providerSelection: "auto"
    }, {
      add: ["Backward compatibility is not required", "Tests must be updated", "All checks must pass"]
    });

    const renderedPlan = JSON.stringify(planned.plan);
    expect(planned.state).toBe("blocked");
    expect(planned.planningRun?.source).toBe("deterministic-fallback");
    expect(planned.planningRun?.approvalBlockedReason).toMatch(/contradicted approved constraints/i);
    expect(planned.planningRun?.diagnostics?.some((diagnostic) =>
      diagnostic.code === "constraint.contradiction.backward_compatibility"
      && diagnostic.affectedPhase === "phase-1"
      && diagnostic.effectiveConstraint === "Backward compatibility is not required"
      && diagnostic.resolution === "blocked"
    )).toBe(true);
    expect(renderedPlan).not.toMatch(/backward-compatible|preserves backward compatibility/i);
  });

  it("repairs an approved-constraint contradiction with exact diagnostics before approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const contradictory = compactPlan("Implement the backward-compatible API behavior.") as Record<string, unknown>;
    (contradictory.phases as Array<Record<string, unknown>>)[0]!.rationale = "This phase performs a backward-compatible migration.";
    const repaired = compactPlan("Implement the approved API behavior with required tests.");
    let repairDiagnostic: unknown;

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderWithRepair({
        plan: contradictory,
        repair: repaired,
        onRepair: (request) => { repairDiagnostic = request.diagnostics[0]; }
      }),
      providerSelection: "auto"
    }, {
      add: ["Backward compatibility is not required", "Tests must be updated", "All checks must pass"]
    });

    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.planningRun?.semanticRepairApplied).toBe(true);
    expect(repairDiagnostic).toMatchObject({
      code: "constraint.contradiction.backward_compatibility",
      affectedPhase: "phase-1",
      effectiveConstraint: "Backward compatibility is not required",
      repairAttempt: "same-model"
    });
    expect(JSON.stringify(planned.plan)).not.toMatch(/backward-compatible|compatibility migration/i);
  });

  it("accepts the recovered rejected model plan without false-positive boundary diagnostics", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Implement GitHub issue #12: deterministic test-obligation planning and evidence gates", root, config: defaultConfig() });

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([recoveredRejectedPlan]),
      providerSelection: "auto"
    });

    expect(planned.planningRun?.source).toBe("model");
    expect(planned.planningRun?.diagnostics ?? []).toEqual([]);
    expect(planned.plan?.phases.map((phase) => phase.id)).toEqual(["phase-1", "phase-2", "phase-3", "phase-4", "phase-5"]);
    expect(planned.plan?.phases[3]?.objective).toContain("migration, security, schema, and compatibility");
    expect(validatePlanQuality(planned.plan!, "rigorous", defaultConfig())).toEqual([]);
  });

  it("repairs malformed JSON once before schema and quality validation", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const malformed = JSON.stringify(compactPlan()).replace(/"revisionRequests":\[\]/, "\"revisionRequests\":[],");

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([malformed]),
      providerSelection: "auto"
    });

    expect(planned.planningRun?.source).toBe("model");
    expect(planned.planningRun?.syntaxRepairApplied).toBe(true);
    expect(planned.planningRun?.warnings.join("\n")).toContain("Planning syntax repair applied once");
  });

  it("repairs schema-valid but quality-invalid plans while preserving valid fields", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const invalid = compactPlan("Do everything needed for issue 12.");
    const repaired = compactPlan("Persist issue-specific test obligation planning.");

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderWithRepair({ plan: invalid, repair: repaired }),
      providerSelection: "auto"
    });

    expect(planned.planningRun?.source).toBe("model");
    expect(planned.planningRun?.semanticRepairApplied).toBe(true);
    expect(planned.planningRun?.diagnostics?.some((diagnostic) => diagnostic.path.includes("objective"))).toBe(true);
    const phase = planned.plan?.phases[0];
    expect(phase?.objective).toBe("Persist issue-specific test obligation planning.");
    expect(phase?.dependencies).toEqual((invalid as { phases: Array<{ dependencies: string[] }> }).phases[0].dependencies);
    expect(phase?.expectedFilesOrAreas).toEqual((invalid as { phases: Array<{ expectedFilesOrAreas: string[] }> }).phases[0].expectedFilesOrAreas);
    expect(phase?.acceptanceCriteria).toEqual((invalid as { phases: Array<{ acceptanceCriteria: string[] }> }).phases[0].acceptanceCriteria);
    expect(phase?.validationCommands).toEqual((invalid as { phases: Array<{ validationCommands: string[] }> }).phases[0].validationCommands);
    expect(planned.plan?.revisionRequests).toEqual([]);
  });

  it("uses same-model semantic repair before any new planning generation", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    let planCalls = 0;
    let repairCalls = 0;

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderWithRepair({
        plan: compactPlan("Do everything needed for issue 12."),
        repair: compactPlan("Persist issue-specific test obligation planning."),
        model: "deepseek-user-medium",
        onPlan: () => { planCalls += 1; },
        onRepair: () => { repairCalls += 1; }
      }),
      providerSelection: "auto"
    });

    expect(planCalls).toBe(1);
    expect(repairCalls).toBe(1);
    expect(planned.planningRun).toMatchObject({ source: "model", model: "deepseek-user-medium", semanticRepairApplied: true });
  });

  it("blocks normal plan approval when generic fallback would replace a repairable model plan", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Implement GitHub issue #12: deterministic test-obligation planning and evidence gates", root, config: defaultConfig() });

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderWithRepair({
        plan: compactPlan("Do everything needed for issue 12."),
        repair: new Error("repair provider unavailable")
      }),
      providerSelection: "auto"
    });

    expect(planned.state).toBe("blocked");
    expect(planned.planningRun?.source).toBe("deterministic-fallback");
    expect(planned.planningRun?.approvalBlockedReason).toMatch(/generic/i);
    expect(planned.blockers.join("\n")).toMatch(/plan approval is disabled/i);
  });

  it("persists model provider warnings when planning succeeds after tier fallback", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([compactPlan()], ["Claude planning provider tier fallback: planning tier 'medium' (model 'sonnet') failed: unavailable"]),
      providerSelection: "auto"
    });

    expect(planned.planningRun?.source).toBe("model");
    expect(planned.planningRun?.warnings.join("\n")).toContain("planning tier 'medium'");
  });

  it("falls back to deterministic planning with a reason when model planning fails", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      provider: planningProviderFrom([{ bad: true }, "still bad"]),
      providerSelection: "auto"
    });

    expect(planned.planningRun?.source).toBe("deterministic-fallback");
    expect(planned.planningRun?.provider).toBe("fake-planner");
    expect(planned.planningRun?.attempts).toBe(2);
    expect(planned.planningRun?.fallbackReason).toBe("model planning failed after 2 attempts");
    expect(planned.planningRun?.warnings.join("\n")).toMatch(/Planning generation attempt 1 failed validation/);
    expect(planned.plan?.phases).toHaveLength(2);
  });

  it("preserves approved constraints in deterministic fallback planning principles", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    const constraints = [
      "Break loadability for existing persisted workflows",
      "Allow phase completion without mandatory obligation evidence"
    ];
    const provider: TriageProvider = {
      name: "fake-triage",
      async recommend() {
        return { raw: recommendation({ constraints }), provider: "fake-triage", model: "triage-test-model" };
      }
    };
    const started = await startFlow({
      request: "Implement GitHub issue #12: deterministic test-obligation planning and evidence gates.",
      root,
      config,
      provider,
      providerSelection: "auto"
    });
    const planned = await approveApproach(root, started.id, defaultConfig(), undefined, {
      providerSelection: "deterministic"
    });

    expect(planned.plan?.principles.join("\n")).toMatch(/Constraint:/i);
    expect(planned.plan?.principles.join("\n")).toContain("Constraint: Break loadability for existing persisted workflows");
    expect(planned.plan?.principles.join("\n")).toContain("Constraint: Allow phase completion without mandatory obligation evidence");
  });

  it("requires stronger gates and phases for Rigorous work", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Change authentication migration handling for production credentials", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);

    expect(started.mode).toBe("rigorous");
    expect(started.approach?.required).toBe(true);
    expect(planned.plan?.phases).toHaveLength(3);
    expect(planned.plan?.phases.every((phase) => phase.modelTier === "large")).toBe(true);
    expect(planned.plan?.phases[0]?.objective).toMatch(/migration|security/i);
  });

  it("validates one-objective phase sizing and rejects broad containers", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, state.id);
    const plan = structuredClone(planned.plan);
    if (!plan) throw new Error("expected plan");
    plan.phases[0] = {
      ...plan.phases[0],
      objective: "Update backend, frontend, tests and docs",
      acceptanceCriteria: ["Done"],
      validationCommands: []
    };

    const issues = validatePlanQuality(plan, "standard", defaultConfig());
    expect(issues.join("\n")).toMatch(/multiple primary objectives|broad|validation|acceptance/i);
  });

  it("splits Standard backend and frontend work into cohesive phases", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the backend and frontend assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);

    expect(planned.mode).toBe("standard");
    expect(planned.plan?.phases.map((phase) => phase.objective)).toEqual([
      "Add the backend behavior or public contract for the requested outcome.",
      "Update the frontend consumer for the approved behavior.",
      "Add focused regression coverage for the changed behavior."
    ]);
  });

  it("rejects invalid transitions", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    await expect(completePhase({ root, workflowId: state.id, phaseId: "phase-1" })).rejects.toThrow(/Invalid transition/);
  });

  it("blocks phase completion when the caller does not hold the persisted lease", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const running = await startPhase(root, executing.id, "phase-1", { ownerId: "owner-a" });

    await expect(completePhase({
      root,
      workflowId: running.id,
      phaseId: "phase-1",
      mutation: { ownerId: "owner-b" }
    })).rejects.toThrow(/completion requires an active lease held by owner-b/);
  });

  it("persists plan revisions before approval", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const revised = await revisePlan(root, state.id, "Keep the change limited to README.md.");

    expect(revised.state).toBe("awaiting_plan_approval");
    expect(revised.plan?.revisionRequests.at(-1)?.feedback).toMatch(/README/);
  });

  it("unlocks phases sequentially", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);
    const executing = await approvePlan(root, planned.id);

    expect(executing.plan?.phases.map((phase) => phase.status)).toEqual(["ready", "planned"]);

    const afterPhase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"]);
    expect(afterPhase1.state).toBe("executing");
    expect(afterPhase1.plan?.phases.map((phase) => phase.status)).toEqual(["completed", "ready"]);
    expect(afterPhase1.plan?.phases[0]?.completion?.dependentPhasesMayProceed).toBe(true);
  });

  it("prevents direct completion without validation and evidence", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    await startPhase(root, executing.id, "phase-1");

    const gated = await completePhase({
      root,
      workflowId: executing.id,
      phaseId: "phase-1",
      config: defaultConfig(),
      filesChanged: ["README.md"]
    });

    expect(gated.plan?.phases[0]?.status).toBe("needs_review");
    expect(gated.plan?.phases[0]?.completion?.dependentPhasesMayProceed).toBe(false);
  });

  it("uses effective approved constraints when evaluating completion evidence", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id, defaultConfig(), undefined, undefined, {
      add: ["Backward compatibility is not required", "Tests must be updated", "All checks must pass"]
    })).id);
    const running = await startPhase(root, executing.id, "phase-1");
    const phase = running.plan!.phases[0]!;
    for (const evidence of validationEvidenceFor(phase, "passed")) {
      await recordValidation({
        root,
        workflowId: running.id,
        phaseId: phase.id,
        command: evidence.command,
        exitStatus: evidence.exitStatus,
        result: evidence.result,
        skipped: evidence.skipped,
        skippedReason: evidence.skippedReason
      });
    }

    const completed = await completePhase({
      root,
      workflowId: running.id,
      phaseId: phase.id,
      config: defaultConfig(),
      criteria: phase.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "met",
        evidence: ["All new fields .optional() to preserve backward compatibility."]
      })),
      filesChanged: ["src/api.ts"],
      commandsRun: phase.validationCommands
    });

    expect(completed.plan?.phases[0]?.status).toBe("needs_review");
    expect(completed.plan?.phases[0]?.completion?.approvedConstraints).toEqual(expect.arrayContaining([
      "Backward compatibility is not required",
      "Tests must be updated",
      "All checks must pass"
    ]));
    expect(completed.plan?.phases[0]?.completion?.reason).toContain("backward compatibility is not required");
  });

  it("failed phase validation moves to needs_repair and keeps dependents locked", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);

    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], { validationStatus: "failed" });

    expect(failed.plan?.phases.map((phase) => phase.status)).toEqual(["needs_repair", "planned"]);
    expect(failed.plan?.phases[0]?.completion?.validation.status).toBe("failed");
  });

  it("passing repair validation clears an earlier failed phase gate", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], { validationStatus: "failed", config });
    const repairing = await repairPhase({ root, workflowId: failed.id, phaseId: "phase-1", reason: "Fix failed validation.", config });

    const repaired = await completePhaseWithEvidence(root, repairing, "phase-1", ["src/api.ts"], { validationStatus: "passed", config });

    expect(repaired.plan?.phases[0]?.status).toBe("completed");
    expect(repaired.plan?.phases[0]?.validationResults.some((evidence) => evidence.status === "failed")).toBe(true);
    expect(repaired.plan?.phases[1]?.status).toBe("ready");
  });

  it("uncertain criteria require review", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const phase = executing.plan?.phases[0];
    if (!phase) throw new Error("expected phase");

    const reviewed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], {
      criteria: phase.acceptanceCriteria.map((criterion) => ({ criterion, status: "uncertain", evidence: ["Looks plausible but not inspected."] }))
    });

    expect(reviewed.plan?.phases[0]?.status).toBe("needs_review");
  });

  it("scope expansion is recorded and escalated for replanning", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);

    const replanned = await completePhaseWithEvidence(root, executing, "phase-1", ["src/runtime.ts"]);

    expect(replanned.plan?.phases[0]?.status).toBe("needs_replan");
    expect(replanned.plan?.phases[0]?.scopeDeviations.join("\n")).toMatch(/scope deviation.*runtime/i);
  });

  it("external blockers stop the workflow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);

    const blocked = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { blockedReason: "Required credentials are unavailable." });

    expect(blocked.state).toBe("blocked");
    expect(blocked.plan?.phases[0]?.status).toBe("blocked");
  });

  it("missing criterion evidence requires review", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const phase = executing.plan?.phases[0];
    if (!phase) throw new Error("expected phase");

    const reviewed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], {
      criteria: phase.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: [] }))
    });

    expect(reviewed.plan?.phases[0]?.status).toBe("needs_review");
    expect(reviewed.plan?.phases[0]?.completion?.reason).toMatch(/Evidence missing/);
  });

  it("allows skipped validation in Fast and rejects it in Standard", async () => {
    const fastRoot = await tempRepo();
    const fastStarted = await startFlow({ request: "Fix a typo in README documentation", root: fastRoot, config: defaultConfig() });
    const fastExecuting = await approvePlan(fastRoot, fastStarted.id);
    const fastComplete = await completePhaseWithEvidence(fastRoot, fastExecuting, "phase-1", ["README.md"], { validationStatus: "skipped" });
    expect(fastComplete.plan?.phases[0]?.status).toBe("completed");

    const standardRoot = await tempRepo();
    const standardStarted = await startFlow({ request: "Fix the broken assignment API regression", root: standardRoot, config: defaultConfig() });
    const standardExecuting = await approvePlan(standardRoot, (await approveApproach(standardRoot, standardStarted.id)).id);
    const standardRepair = await completePhaseWithEvidence(standardRoot, standardExecuting, "phase-1", ["src/api.ts"], { validationStatus: "skipped" });
    expect(standardRepair.plan?.phases[0]?.status).toBe("needs_repair");
  });

  it("detects changed files outside expected scope", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    if (!executing.plan) throw new Error("expected plan");
    executing.plan.phases[0].expectedFilesOrAreas = ["src/api.ts"];
    await saveFlowState(root, executing, { expectedRevision: executing.revision });

    const replanned = await completePhaseWithEvidence(root, executing, "phase-1", ["src/other.ts"]);

    expect(replanned.plan?.phases[0]?.status).toBe("needs_replan");
    expect(replanned.plan?.phases[0]?.scopeDeviations.join("\n")).toMatch(/outside expected scope/);
  });

  it("bounds per-phase repair attempts", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    config.completionGate.maxRepairAttempts.fast = 1;
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config });
    const executing = await approvePlan(root, started.id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { validationStatus: "failed", config });
    const repairing = await repairPhase({ root, workflowId: failed.id, phaseId: "phase-1", reason: "Fix failed validation.", config });
    const failedAgain = await completePhaseWithEvidence(root, repairing, "phase-1", ["README.md"], { validationStatus: "failed", config });
    const exhausted = await repairPhase({ root, workflowId: failedAgain.id, phaseId: "phase-1", reason: "Retry again.", config });

    expect(exhausted.plan?.phases[0]?.status).toBe("needs_review");
    expect(exhausted.plan?.phases[0]?.completion?.reason).toMatch(/Repair budget exhausted/);
  });

  it("persists completion records across resume", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const completed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
    const resumed = await loadFlowState(root, completed.id);

    expect(resumed.plan?.phases[0]?.completion?.criteria[0]?.status).toBe("met");
    expect(resumed.plan?.phases[0]?.completion?.workflowRevision).toBeGreaterThanOrEqual(0);
  });

  it("requires final integrated review after all phase gates pass", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);

    expect(validating.state).toBe("validating");
    expect(validating.commitPlan).toBeUndefined();
  });

  it("deterministic policy overrides an optimistic model gate result", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { validationStatus: "failed", modelDecision: "completed" });

    expect(failed.plan?.phases[0]?.status).toBe("needs_repair");
    expect(failed.plan?.phases[0]?.completion?.decision).not.toBe("completed");
  });

  it("persists validation evidence and commit proposals without committing", async () => {
    const root = await tempRepo();
    const state = await runFastToReview(root);

    expect(state.state).toBe("awaiting_commit_approval");
    expect(state.validation).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "git diff --check", exitStatus: 0, status: "passed" })
    ]));
    expect(state.commitPlan?.note).toMatch(/never runs git commit/i);

    const proposal = await getCommitPlan(root, state.id);
    expect(proposal.groups[0].commands.join("\n")).toMatch(/git commit -m/);
  });

  it("limits integrated review repair loops", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    config.budgets.repairRounds = 1;
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config });
    const executing = await approvePlan(root, started.id);
    const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);

    const repair = await recordReview({ root, workflowId: validating.id, status: "needs_repair", summary: "One missing detail.", repairScope: "Tighten README wording.", config });
    expect(repair.state).toBe("executing");
    expect(repair.plan?.phases.at(-1)?.id).toBe("repair-1");

    const validatingAgain = await completePhaseWithEvidence(root, repair, "repair-1", ["README.md"]);
    const blocked = await recordReview({ root, workflowId: validatingAgain.id, status: "needs_repair", summary: "Still incomplete.", repairScope: "Second repair.", config });
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockers[0]).toMatch(/Repair budget exhausted/);
  });

  it("can reject approach and cancel workflows", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const rejected = await rejectApproach(root, started.id, "Need a different implementation direction.");
    expect(rejected.state).toBe("blocked");

    const second = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const cancelled = await cancelFlow(root, second.id);
    expect(cancelled.state).toBe("cancelled");
  });

  it("survives process-style resume and lists repository-local workflows", async () => {
    const root = await tempRepo();
    const created = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const resumed = await resumeFlow(root, created.id);
    const listed = await listFlows(root);

    expect(resumed.id).toBe(created.id);
    expect(listed.map((entry) => entry.id)).toContain(created.id);
  });

  it("detects stale and corrupted workflow state", async () => {
    const root = await tempRepo();
    const created = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const stale = structuredClone(created) as SequentialWorkflowState;
    await revisePlan(root, created.id, "Add a diff sanity note.");

    await expect(saveFlowState(root, stale, { expectedRevision: stale.revision })).rejects.toThrow(/expected/);

    await writeFile(path.join(root, ".leanrigor", "workflows", "broken.json"), "{ nope");
    await expect(loadFlowState(root, "broken")).rejects.toThrow(/corrupted/i);
  });

  it("runs a complete Fast deterministic flow", async () => {
    const root = await tempRepo();
    const reviewed = await runFastToReview(root);
    const completed = await completeFlow(root, reviewed.id);

    expect(completed.state).toBe("completed");
  });

  it("runs a complete Standard deterministic flow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const phase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"]);
    const validating = await completePhaseWithEvidence(root, phase1, "phase-2", ["src/api.test.ts"]);
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Integrated review passed.", config: defaultConfig() });

    expect(reviewed.state).toBe("awaiting_commit_approval");
    expect(reviewed.commitPlan?.groups).toHaveLength(2);
  });

  it("runs a complete Rigorous deterministic flow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Change authentication migration handling for production credentials", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const phase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/auth.ts"]);
    const phase2 = await completePhaseWithEvidence(root, phase1, "phase-2", ["src/auth.ts"]);
    const validating = await completePhaseWithEvidence(root, phase2, "phase-3", ["tests/auth.test.ts"]);
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Deep integrated review passed.", config: defaultConfig() });

    expect(reviewed.mode).toBe("rigorous");
    expect(reviewed.state).toBe("awaiting_commit_approval");
  });
});

describe("evidence template", () => {
  it("returns criteria matching phase acceptance criteria", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Add a practical first-workflow guide for new LeanRigor users. Create docs/first-workflow.md and link it prominently from README.md.", root, config: defaultConfig() });
    if (!state.plan) throw new Error("expected plan");
    const phase = state.plan.phases[0];
    if (!phase) throw new Error("expected phase");

    const template = getEvidenceTemplate(phase);

    expect(template.phaseId).toBe(phase.id);
    expect(template.objective).toBe(phase.objective);
    expect(template.criteria).toHaveLength(phase.acceptanceCriteria.length);
    expect(template.criteria.every((c) => typeof c.criterion === "string" && c.criterion.length > 0)).toBe(true);
    expect(template.criteria.every((c) => c.status === "met")).toBe(true);
  });

  it("includes all required CompletionEvidenceFile fields with instructions", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    if (!state.plan) throw new Error("expected plan");
    const phase = state.plan.phases[0];
    if (!phase) throw new Error("expected phase");

    const template = getEvidenceTemplate(phase);

    expect(template).toHaveProperty("phaseId");
    expect(template).toHaveProperty("objective");
    expect(template).toHaveProperty("criteria");
    expect(template).toHaveProperty("filesChanged");
    expect(template).toHaveProperty("validation");
    expect(template).toHaveProperty("scopeDeviations");
    expect(template).toHaveProperty("assumptions");
    expect(template).toHaveProperty("remainingRisks");
    expect(template).toHaveProperty("_instructions");
    expect(template._instructions).toHaveProperty("criteria");
    expect(template._instructions).toHaveProperty("validation");
    expect(template._instructions).toHaveProperty("filesChanged");
  });

  it("populates validation entries from phase validation commands", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, state.id, defaultConfig());
    if (!planned.plan) throw new Error("expected plan");
    const phase = planned.plan.phases[0];
    if (!phase) throw new Error("expected phase");

    const template = getEvidenceTemplate(phase);

    expect(template.validation.length).toBeGreaterThan(0);
    expect(template.validation.every((v) => typeof v.command === "string" && v.command.length > 0)).toBe(true);
    expect(template.validation.every((v) => v.status === "passed")).toBe(true);
  });
});

describe("scope classification", () => {
  it("classifies README.md as documentation", () => {
    expect(classifyFilePath("README.md")).toBe("documentation");
    expect(classifyFilePath("readme.md")).toBe("documentation");
    expect(classifyFilePath("./README.md")).toBe("documentation");
  });

  it("classifies docs/ paths as documentation", () => {
    expect(classifyFilePath("docs/first-workflow.md")).toBe("documentation");
    expect(classifyFilePath("docs/guides/setup.md")).toBe("documentation");
  });

  it("classifies TypeScript source as runtime", () => {
    expect(classifyFilePath("src/main.ts")).toBe("runtime");
    expect(classifyFilePath("src/core/flow.ts")).toBe("runtime");
    expect(classifyFilePath("lib/utils.js")).toBe("runtime");
  });

  it("classifies test files as test", () => {
    expect(classifyFilePath("tests/flow.test.ts")).toBe("test");
    expect(classifyFilePath("src/__tests__/utils.test.ts")).toBe("test");
    expect(classifyFilePath("src/components/button.spec.tsx")).toBe("test");
  });

  it("classifies config files as config", () => {
    expect(classifyFilePath("package.json")).toBe("config");
    expect(classifyFilePath("tsconfig.json")).toBe("config");
    expect(classifyFilePath(".env")).toBe("config");
  });

  it("strips (modified) annotations before classification", () => {
    expect(classifyFilePath("README.md (modified)")).toBe("documentation");
    expect(classifyFilePath("src/main.ts (new file)")).toBe("runtime");
    expect(classifyFilePath("README.md\t(modified)")).toBe("documentation");
  });

  it("documentation phase changing README.md and docs/first-workflow.md passes scope validation", async () => {
    const root = await tempRepo();
    const state = await startFlow({
      request: "Add a practical first-workflow guide for new LeanRigor users. Create docs/first-workflow.md and link it prominently from README.md.",
      root,
      config: defaultConfig()
    });
    const executing = await approvePlan(root, state.id);
    if (!executing.plan) throw new Error("expected plan");
    const phase = executing.plan.phases[0];
    if (!phase) throw new Error("expected phase");

    const result = await completePhaseWithEvidence(root, executing, phase.id, ["docs/first-workflow.md", "README.md"]);

    const deviations = result.plan?.phases[0]?.scopeDeviations ?? [];
    const runtimeDeviations = deviations.filter((d) => d.includes("runtime") || d.includes("scope deviation"));
    expect(runtimeDeviations).toHaveLength(0);
    expect(result.plan?.phases[0]?.status).toBe("completed");
  });

  it("documentation phase changing a runtime file triggers needs_replan", async () => {
    const root = await tempRepo();
    const state = await startFlow({
      request: "Add a practical first-workflow guide for new LeanRigor users. Create docs/first-workflow.md and link it prominently from README.md.",
      root,
      config: defaultConfig()
    });
    const executing = await approvePlan(root, state.id);
    if (!executing.plan) throw new Error("expected plan");
    const phase = executing.plan.phases[0];
    if (!phase) throw new Error("expected phase");

    const result = await completePhaseWithEvidence(root, executing, phase.id, ["src/core/flow.ts"]);

    expect(result.plan?.phases[0]?.status).toBe("needs_replan");
    const deviations = result.plan?.phases[0]?.scopeDeviations ?? [];
    expect(deviations.some((d) => d.includes("scope deviation") && d.includes("runtime"))).toBe(true);
  });

  it("diagnostic identifies expected areas and unexpected paths", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, state.id);
    if (!executing.plan) throw new Error("expected plan");
    executing.plan.phases[0].expectedFilesOrAreas = ["README.md"];
    await saveFlowState(root, executing, { expectedRevision: executing.revision });

    const result = await completePhaseWithEvidence(root, executing, "phase-1", ["src/other.ts"]);

    const deviations = result.plan?.phases[0]?.scopeDeviations ?? [];
    const docDeviation = deviations.find((d) => d.includes("scope deviation") || d.includes("classified"));
    expect(docDeviation).toBeDefined();
    expect(docDeviation).toMatch(/classified as runtime/i);
    expect(docDeviation).toMatch(/expected/i);
    expect(docDeviation).toContain("README.md");
  });
});

async function runFastToReview(root: string): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
  const executing = await approvePlan(root, started.id);
  const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
  return recordReview({ root, workflowId: validating.id, status: "passed", summary: "Diff sanity review passed.", config: defaultConfig() });
}

async function completePhaseWithEvidence(root: string, state: SequentialWorkflowState, phaseId: string, filesChanged: string[], options: {
  criteria?: CriterionCompletionEvidence[];
  validationStatus?: "passed" | "failed" | "skipped";
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  config?: ReturnType<typeof defaultConfig>;
  modelDecision?: "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
} = {}): Promise<SequentialWorkflowState> {
    const current = await resumeFlow(root, state.id);
    const phase = current.plan?.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) throw new Error(`Missing phase ${phaseId}`);
  const executable = phase.status === "ready" ? await startPhase(root, state.id, phaseId) : current;
  const runningPhase = executable.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!runningPhase) throw new Error(`Missing phase ${phaseId}`);
  for (const evidence of validationEvidenceFor(runningPhase, options.validationStatus ?? "passed")) {
    await recordValidation({
      root,
      workflowId: executable.id,
      phaseId,
      command: evidence.command,
      exitStatus: evidence.exitStatus,
      result: evidence.result,
      skipped: evidence.skipped,
      skippedReason: evidence.skippedReason
    });
  }
  return completePhase({
    root,
    workflowId: executable.id,
    phaseId,
    config: options.config ?? defaultConfig(),
    criteria: options.criteria ?? metCriteria(runningPhase),
    filesChanged,
    commandsRun: runningPhase.validationCommands,
    scopeDeviations: options.scopeDeviations,
    assumptions: options.assumptions,
    remainingRisks: options.remainingRisks,
    blockedReason: options.blockedReason,
    modelDecision: options.modelDecision
  });
}

function metCriteria(phase: WorkflowPhase): CriterionCompletionEvidence[] {
  return phase.acceptanceCriteria.map((criterion) => ({
    criterion,
    status: "met",
    evidence: [`Evidence recorded for ${phase.id}: ${criterion}`]
  }));
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
    approachSummary: "Implement deterministic test-obligation planning and evidence gates.",
    needsAdditionalInspection: false,
    inspectionQuestions: [],
    evidenceReferences: [],
    taskType: "feature",
    clarification: { required: false, question: null, reason: null },
    ...overrides
  };
}

function validationEvidenceFor(phase: WorkflowPhase, status: "passed" | "failed" | "skipped"): ValidationEvidence[] {
  return phase.validationCommands.map((command, index) => ({
    phaseId: phase.id,
    command,
    exitStatus: status === "skipped" ? null : status === "failed" && index === 0 ? 1 : 0,
    result: status === "failed" && index === 0 ? "validation failed" : status === "skipped" ? "validation skipped" : "validation passed",
    status: status === "failed" && index === 0 ? "failed" : status,
    skipped: status === "skipped",
    skippedReason: status === "skipped" ? "Not relevant for this deterministic test." : undefined,
    timestamp: new Date().toISOString()
  }));
}
