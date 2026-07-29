import { createHash } from "node:crypto";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import { dependencyIds } from "./scheduler.js";
import { isRepositoryPathPattern } from "./repository-path.js";
import {
  dependencyFingerprint,
  executionPolicyHash,
  phasePlanFingerprint,
  priorPhaseOutcomesHash
} from "./dispatch-eligibility.js";
import {
  derivePhaseBriefInspectionRequest,
  inspectPhaseBrief,
  repositoryRevision,
  type PhaseBriefInspectionIo
} from "./phase-brief-inspection.js";
import {
  classifyPhaseBriefFailure,
  evaluatePhaseBriefQuality,
  recoveryAttempt
} from "./workflow-quality.js";
import type {
  ArtifactRecoveryAttempt,
  MaterialPlanChange,
  PhaseBriefDiagnostic,
  PhaseBriefGenerationFailure,
  PhaseBriefInspectionResult,
  PhaseBriefRiskCategory,
  PhaseBriefRiskDiscovery,
  PhaseExecutionBrief,
  SequentialWorkflowState,
  WorkflowPhase
} from "./types.js";

export interface PhaseBriefProposal {
  objective: string;
  deliverable: string;
  currentBehaviour: string;
  implementationApproach: string;
  readAreas: string[];
  writeAreas: string[];
  relevantFiles: string[];
  relevantSymbols: string[];
  dependencies: string[];
  assumptions: string[];
  exclusions: string[];
  acceptanceCriteria: string[];
  testObligations: string[];
  validationCommands: string[];
  manualValidationPlan?: string;
  risks: string[];
  riskDiscoveries?: PhaseBriefRiskDiscovery[];
}

const canonicalRiskCategoryPatterns: Array<[PhaseBriefRiskCategory, RegExp]> = [
  ["security", /\b(?:security|secure|auth(?:entication|orization)?|credentials?|secrets?|permissions?|access[- ]control|tokens?)\b/i],
  ["public-contract", /\b(?:public(?:[- ](?:api|contract))?|apis?|contracts?|compatib(?:ility|le)|downstream consumers?)\b/i],
  ["migration", /\b(?:migrat(?:e|ion|ing)|schemas?|databases?|persisted state|serializ(?:e|ation))\b/i],
  ["architecture", /\b(?:architecture|architectural|component ownership|ownership boundary|cross[- ]boundary)\b/i],
  ["data-integrity", /\b(?:data[ -]integrity|data loss|corrupt(?:ion|ed)?)\b/i],
  ["concurrency", /\b(?:concurren(?:cy|t)|race conditions?|locking|deadlocks?)\b/i],
  ["recovery", /\b(?:recovery|recover|idempoten(?:t|cy)|rollback|retry)\b/i],
  ["production-infrastructure", /\b(?:production|deploy(?:ment|ing)?|infrastructure)\b/i],
  ["destructive-operation", /\b(?:destructive|delete|destroy|drop)\b/i],
  ["network-operation", /\b(?:network|outbound|external service|remote service)\b/i]
];

export function canonicalRiskCategories(value: string): PhaseBriefRiskCategory[] {
  return canonicalRiskCategoryPatterns
    .filter(([, pattern]) => pattern.test(value))
    .map(([category]) => category);
}

export type AcceptanceOutcomeCategory =
  | "persistence"
  | "compatibility"
  | "schema"
  | "public-contract"
  | "cli"
  | "workflow-state"
  | "failure-handling"
  | "migration"
  | "security"
  | "concurrency"
  | "integration"
  | "documentation"
  | "validation";

export interface PhaseBriefPlanningInput {
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  inspection: PhaseBriefInspectionResult;
  config: LeanRigorConfig;
  previous?: PhaseExecutionBrief;
  feedback?: string;
}

export interface PhaseBriefPlanningResult {
  proposal: PhaseBriefProposal;
  provider: string;
  modelTier?: ModelTier;
  warnings?: string[];
}

export interface PhaseBriefRepairRequest {
  brief: PhaseExecutionBrief;
  diagnostics: PhaseBriefDiagnostic[];
}

export interface PhaseBriefPlanningProvider {
  name: string;
  generate(input: PhaseBriefPlanningInput): Promise<PhaseBriefPlanningResult>;
  repair?(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): Promise<PhaseBriefPlanningResult>;
  alternate?(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): Promise<PhaseBriefPlanningResult>;
}

export type PhaseBriefGenerationOutcome =
  | { status: "generated"; brief: PhaseExecutionBrief }
  | { status: "blocked"; failure: PhaseBriefGenerationFailure };

export class DeterministicPhaseBriefPlanningProvider implements PhaseBriefPlanningProvider {
  readonly name = "deterministic-phase-brief";

  async generate(input: PhaseBriefPlanningInput): Promise<PhaseBriefPlanningResult> {
    return {
      proposal: deterministicProposal(input),
      provider: this.name,
      modelTier: input.phase.modelTier
    };
  }

  async repair(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): Promise<PhaseBriefPlanningResult> {
    const baseline = deterministicProposal(input);
    const deficient = new Set(request.diagnostics.map((diagnostic) => diagnostic.field));
    const proposal = proposalFromBrief(request.brief);
    for (const field of deficient) copyProposalField(proposal, baseline, field);
    return {
      proposal,
      provider: this.name,
      modelTier: input.phase.modelTier,
      warnings: ["Deterministic same-provider repair changed only fields named by quality diagnostics."]
    };
  }
}

export async function generateInspectedPhaseExecutionBrief(args: {
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  config: LeanRigorConfig;
  previous?: PhaseExecutionBrief;
  feedback?: string;
  provider?: PhaseBriefPlanningProvider;
  inspectionIo?: PhaseBriefInspectionIo;
}): Promise<PhaseBriefGenerationOutcome> {
  const provider: PhaseBriefPlanningProvider = args.provider ?? new DeterministicPhaseBriefPlanningProvider();
  const recoveryAttempts: ArtifactRecoveryAttempt[] = [];
  const initialRequest = derivePhaseBriefInspectionRequest(args.state, args.phase, args.config);
  const inspected = await inspectPhaseBrief({
    root: args.state.root,
    state: args.state,
    phase: args.phase,
    request: initialRequest,
    io: args.inspectionIo,
    provider: provider.name
  });
  const planRevision = args.state.approval?.workflowPlanRevision ?? args.state.revision;
  const initialBriefRevision = (args.previous?.briefRevision ?? 0) + 1;
  const tier = args.phase.modelTier;
  if (["failed", "unavailable"].includes(inspected.result.status)) {
    return blockedFailure({
      phase: args.phase,
      workflowRevision: planRevision,
      briefRevision: initialBriefRevision,
      status: inspected.result.status === "failed" ? "inspection-failed" : "inspection-unavailable",
      message: inspected.result.status === "failed"
        ? `${args.phase.id} bounded inspection did not complete within its deterministic limits.`
        : `${args.phase.id} implementation boundary could not be located within the approved inspection paths.`,
      diagnostics: inspected.result.unresolvedQuestions.map((question) => diagnostic("inspection", "inspectionResult", "inspection.unresolved", question)),
      request: inspected.request,
      result: inspected.result,
      repairAttempts: 0,
      provider: provider.name,
      modelTier: tier,
      recoveryAttempts
    });
  }

  let currentInspection = inspected;
  let input: PhaseBriefPlanningInput = {
    state: args.state,
    phase: args.phase,
    inspection: inspected.result,
    config: args.config,
    previous: args.previous,
    feedback: args.feedback
  };
  let generation: PhaseBriefPlanningResult;
  try {
    generation = await provider.generate(input);
  } catch (error) {
    const diagnostics = [diagnostic("generation", "brief", "generation.provider_failed", messageOf(error))];
    recoveryAttempts.push(recoveryAttempt({
      attempts: recoveryAttempts,
      strategy: "initial-generation",
      provider: provider.name,
      modelTier: tier,
      input: { phase: args.phase, inspection: inspected.result },
      inspectionIdentity: stableHash(inspected.result),
      diagnostics,
      disposition: "failed"
    }));
    return blockedFailure({
      phase: args.phase,
      workflowRevision: planRevision,
      briefRevision: initialBriefRevision,
      status: "quality-blocked",
      message: `${args.phase.id} brief-planning provider failed: ${messageOf(error)}`,
      diagnostics,
      request: inspected.request,
      result: inspected.result,
      repairAttempts: 0,
      provider: provider.name,
      modelTier: tier,
      recoveryAttempts
    });
  }

  const repo = await repositoryRevision(args.state.root);
  const constraintHash = stableHash(effectiveConstraints(args.state));
  let inspectionResultId = phaseBriefInspectionIdentity(inspected.result);
  let brief = assembleBrief({
    state: args.state,
    phase: args.phase,
    previous: args.previous,
    feedback: args.feedback,
    proposal: generation.proposal,
    provider: generation.provider,
    modelTier: generation.modelTier ?? tier,
    warnings: generation.warnings ?? [],
    request: inspected.request,
    inspection: inspected.result,
    workflowRevision: planRevision,
    briefRevision: initialBriefRevision,
    repository: {
      baseCommit: repo.baseCommit,
      repositoryRevision: repo.baseCommit ?? `tree:${inspectionResultId}`,
      constraintHash,
      inspectionResultId,
      inspectedPaths: inspected.result.filesRead,
      planFingerprint: phasePlanFingerprint(args.phase),
      dependencyFingerprint: dependencyFingerprint(args.phase),
      priorPhaseOutcomesHash: priorPhaseOutcomesHash(args.state, args.phase),
      executionPolicyHash: executionPolicyHash(args.phase, args.config)
    },
    repairAttempts: 0
  });
  let diagnostics = validatePhaseExecutionBrief(brief, args.phase);
  recoveryAttempts.push(recoveryAttempt({
    attempts: recoveryAttempts,
    strategy: "initial-generation",
    provider: generation.provider,
    modelTier: generation.modelTier ?? tier,
    input: { phase: args.phase, inspection: inspected.result },
    output: generation.proposal,
    inspectionIdentity: inspectionResultId,
    diagnostics,
    disposition: diagnostics.length === 0 ? "succeeded" : "continue"
  }));
  brief.recoveryAttempts = [...recoveryAttempts];
  brief.quality = evaluatePhaseBriefQuality(brief, args.phase, diagnostics);
  const maxRepairs = Math.min(args.config.budgets.phaseBriefRepairAttempts, provider.repair ? 1 : 0);

  if (diagnostics.length > 0 && maxRepairs > 0 && provider.repair) {
    try {
      const repaired = await provider.repair(input, {
        brief,
        diagnostics: diagnostics.map((item) => ({ ...item, repairAttempt: "same-provider" }))
      });
      const repairedProposal = mergeDiagnosedFields(generation.proposal, repaired.proposal, diagnostics);
      brief = assembleBrief({
        state: args.state,
        phase: args.phase,
        previous: args.previous,
        feedback: args.feedback,
        proposal: repairedProposal,
        provider: repaired.provider,
        modelTier: repaired.modelTier ?? generation.modelTier ?? tier,
        warnings: unique([...(generation.warnings ?? []), ...(repaired.warnings ?? [])]),
        request: inspected.request,
        inspection: inspected.result,
        workflowRevision: planRevision,
        briefRevision: initialBriefRevision + 1,
        repository: brief.repository,
        repairAttempts: 1
      });
      const repairedDiagnostics = validatePhaseExecutionBrief(brief, args.phase);
      const unresolvedKeys = new Set(repairedDiagnostics.map((item) => `${item.field}:${item.code}`));
      brief.validation.diagnostics = [
        ...diagnostics.map((item) => ({
          ...item,
          repairAttempt: "same-provider" as const,
          resolution: unresolvedKeys.has(`${item.field}:${item.code}`) ? "unresolved" as const : "repaired" as const
        })),
        ...repairedDiagnostics.filter((item) => !diagnostics.some((original) => original.field === item.field && original.code === item.code))
      ];
      diagnostics = repairedDiagnostics;
      recoveryAttempts.push(recoveryAttempt({
        attempts: recoveryAttempts,
        strategy: "targeted-repair",
        provider: repaired.provider,
        modelTier: repaired.modelTier ?? generation.modelTier ?? tier,
        input: generation.proposal,
        output: repairedProposal,
        inspectionIdentity: inspectionResultId,
        diagnostics: repairedDiagnostics,
        disposition: repairedDiagnostics.length === 0 ? "succeeded" : "continue"
      }));
      brief.recoveryAttempts = [...recoveryAttempts];
      brief.quality = evaluatePhaseBriefQuality(brief, args.phase, repairedDiagnostics);
    } catch (error) {
      diagnostics.push(diagnostic("generation", "brief", "repair.provider_failed", messageOf(error), "same-provider"));
      recoveryAttempts.push(recoveryAttempt({
        attempts: recoveryAttempts,
        strategy: "targeted-repair",
        provider: provider.name,
        modelTier: tier,
        input: generation.proposal,
        inspectionIdentity: inspectionResultId,
        diagnostics,
        disposition: "failed"
      }));
    }
  }

  if (diagnostics.length > 0 && args.config.budgets.phaseBriefRefreshedInspectionAttempts > 0) {
    const refreshed = await inspectPhaseBrief({
      root: args.state.root,
      state: args.state,
      phase: args.phase,
      request: derivePhaseBriefInspectionRequest(args.state, args.phase, args.config),
      io: args.inspectionIo,
      provider: provider.name
    });
    const refreshedIdentity = phaseBriefInspectionIdentity(refreshed.result);
    if (refreshedIdentity === inspectionResultId) {
      recoveryAttempts.push(recoveryAttempt({
        attempts: recoveryAttempts,
        strategy: "refreshed-inspection",
        provider: provider.name,
        modelTier: tier,
        input: { phase: args.phase, inspectionIdentity: inspectionResultId },
        inspectionIdentity: inspectionResultId,
        diagnostics,
        disposition: "skipped-identical"
      }));
    } else if (!["failed", "unavailable"].includes(refreshed.result.status)) {
      currentInspection = refreshed;
      inspectionResultId = refreshedIdentity;
      input = {
        ...input,
        inspection: refreshed.result,
        feedback: recoveryFeedback(args.feedback, diagnostics, "Use the refreshed bounded repository evidence.")
      };
      try {
        const refreshedGeneration = await provider.generate(input);
        const refreshedBrief = assembleBrief({
          state: args.state,
          phase: args.phase,
          previous: args.previous,
          feedback: input.feedback,
          proposal: refreshedGeneration.proposal,
          provider: refreshedGeneration.provider,
          modelTier: refreshedGeneration.modelTier ?? tier,
          warnings: unique([...(brief.generation.warnings ?? []), ...(refreshedGeneration.warnings ?? []), "LeanRigor refreshed bounded repository inspection before regenerating this brief."]),
          request: refreshed.request,
          inspection: refreshed.result,
          workflowRevision: planRevision,
          briefRevision: brief.briefRevision + 1,
          repository: {
            ...brief.repository,
            inspectionResultId,
            inspectedPaths: refreshed.result.filesRead
          },
          repairAttempts: brief.validation.repairAttempts
        });
        const refreshedDiagnostics = validatePhaseExecutionBrief(refreshedBrief, args.phase);
        recoveryAttempts.push(recoveryAttempt({
          attempts: recoveryAttempts,
          strategy: "refreshed-inspection",
          provider: refreshedGeneration.provider,
          modelTier: refreshedGeneration.modelTier ?? tier,
          input: { phase: args.phase, inspection: refreshed.result },
          output: refreshedGeneration.proposal,
          inspectionIdentity: inspectionResultId,
          diagnostics: refreshedDiagnostics,
          disposition: refreshedDiagnostics.length === 0 ? "succeeded" : "continue"
        }));
        brief = refreshedBrief;
        diagnostics = refreshedDiagnostics;
      } catch (error) {
        const refreshedDiagnostics = [
          ...diagnostics,
          diagnostic("generation", "brief", "refresh.provider_failed", messageOf(error))
        ];
        recoveryAttempts.push(recoveryAttempt({
          attempts: recoveryAttempts,
          strategy: "refreshed-inspection",
          provider: provider.name,
          modelTier: tier,
          input: { phase: args.phase, inspection: refreshed.result },
          inspectionIdentity: inspectionResultId,
          diagnostics: refreshedDiagnostics,
          disposition: "failed"
        }));
        diagnostics = refreshedDiagnostics;
      }
    } else {
      recoveryAttempts.push(recoveryAttempt({
        attempts: recoveryAttempts,
        strategy: "refreshed-inspection",
        provider: provider.name,
        modelTier: tier,
        input: { phase: args.phase, inspection: refreshed.result },
        inspectionIdentity: refreshedIdentity,
        diagnostics,
        disposition: "failed"
      }));
    }
    brief.recoveryAttempts = [...recoveryAttempts];
    brief.quality = evaluatePhaseBriefQuality(brief, args.phase, diagnostics);
  }

  if (diagnostics.length > 0 && args.config.budgets.phaseBriefAlternateStrategyAttempts > 0) {
    if (provider.alternate) {
      try {
        const alternate = await provider.alternate(input, { brief, diagnostics });
        const alternateBrief = assembleBrief({
          state: args.state,
          phase: args.phase,
          previous: args.previous,
          feedback: recoveryFeedback(args.feedback, diagnostics, "Use an alternative planning strategy while preserving approved scope."),
          proposal: alternate.proposal,
          provider: alternate.provider,
          modelTier: alternate.modelTier ?? tier,
          warnings: unique([...(brief.generation.warnings ?? []), ...(alternate.warnings ?? []), "LeanRigor used a bounded alternative planning strategy after diagnosed repair remained invalid."]),
          request: currentInspection.request,
          inspection: currentInspection.result,
          workflowRevision: planRevision,
          briefRevision: brief.briefRevision + 1,
          repository: brief.repository,
          repairAttempts: brief.validation.repairAttempts
        });
        const alternateDiagnostics = validatePhaseExecutionBrief(alternateBrief, args.phase);
        recoveryAttempts.push(recoveryAttempt({
          attempts: recoveryAttempts,
          strategy: "alternate-strategy",
          provider: alternate.provider,
          modelTier: alternate.modelTier ?? tier,
          input: brief,
          output: alternate.proposal,
          inspectionIdentity: inspectionResultId,
          diagnostics: alternateDiagnostics,
          disposition: alternateDiagnostics.length === 0 ? "succeeded" : "continue"
        }));
        brief = alternateBrief;
        diagnostics = alternateDiagnostics;
      } catch (error) {
        const alternateDiagnostics = [
          ...diagnostics,
          diagnostic("generation", "brief", "alternate.provider_failed", messageOf(error))
        ];
        recoveryAttempts.push(recoveryAttempt({
          attempts: recoveryAttempts,
          strategy: "alternate-strategy",
          provider: provider.name,
          modelTier: tier,
          input: brief,
          inspectionIdentity: inspectionResultId,
          diagnostics: alternateDiagnostics,
          disposition: "failed"
        }));
        diagnostics = alternateDiagnostics;
      }
    } else {
      recoveryAttempts.push(recoveryAttempt({
        attempts: recoveryAttempts,
        strategy: "alternate-strategy",
        provider: provider.name,
        modelTier: tier,
        input: brief,
        inspectionIdentity: inspectionResultId,
        diagnostics,
        disposition: "failed"
      }));
    }
    brief.recoveryAttempts = [...recoveryAttempts];
    brief.quality = evaluatePhaseBriefQuality(brief, args.phase, diagnostics);
  }

  if (
    diagnostics.length > 0
    && provider.name !== "deterministic-phase-brief"
    && args.config.budgets.phaseBriefDeterministicFallbackAttempts > 0
  ) {
    const fallbackProvider = new DeterministicPhaseBriefPlanningProvider();
    const fallback = await fallbackProvider.generate(input);
    const fallbackBrief = assembleBrief({
      state: args.state,
      phase: args.phase,
      previous: args.previous,
      feedback: args.feedback,
      proposal: fallback.proposal,
      provider: fallback.provider,
      modelTier: fallback.modelTier ?? tier,
      warnings: unique([...(generation.warnings ?? []), "LeanRigor deterministically synthesized a conservative brief after provider repair failed."]),
      request: currentInspection.request,
      inspection: currentInspection.result,
      workflowRevision: planRevision,
      briefRevision: brief.briefRevision + 1,
      repository: brief.repository,
      repairAttempts: brief.validation.repairAttempts
    });
    const fallbackDiagnostics = validatePhaseExecutionBrief(fallbackBrief, args.phase);
    recoveryAttempts.push(recoveryAttempt({
      attempts: recoveryAttempts,
      strategy: "deterministic-fallback",
      provider: fallback.provider,
      modelTier: fallback.modelTier ?? tier,
      input: brief,
      output: fallback.proposal,
      inspectionIdentity: inspectionResultId,
      diagnostics: fallbackDiagnostics,
      disposition: fallbackDiagnostics.length === 0 ? "succeeded" : "failed"
    }));
    fallbackBrief.recoveryAttempts = [...recoveryAttempts];
    fallbackBrief.deterministicallySynthesized = true;
    fallbackBrief.quality = evaluatePhaseBriefQuality(fallbackBrief, args.phase, fallbackDiagnostics);
    if (fallbackDiagnostics.length === 0) {
      brief = fallbackBrief;
      diagnostics = [];
    } else {
      brief = fallbackBrief;
      diagnostics = fallbackDiagnostics;
    }
  }

  if (diagnostics.length > 0) {
    return blockedFailure({
      phase: args.phase,
      workflowRevision: planRevision,
      briefRevision: brief.briefRevision,
      status: "quality-blocked",
      message: `${args.phase.id} execution brief failed deterministic quality validation.`,
      diagnostics: brief.validation.diagnostics.length > 0 ? brief.validation.diagnostics : diagnostics,
      request: currentInspection.request,
      result: currentInspection.result,
      repairAttempts: brief.validation.repairAttempts,
      provider: brief.generation.provider,
      modelTier: brief.generation.modelTier,
      recoveryAttempts,
      quality: evaluatePhaseBriefQuality(brief, args.phase, diagnostics)
    });
  }

  brief.validation = {
    status: "valid",
    diagnostics: brief.validation.diagnostics,
    repairAttempts: brief.validation.repairAttempts,
    validatedAt: new Date().toISOString()
  };
  brief.recoveryAttempts = [...recoveryAttempts];
  brief.quality = evaluatePhaseBriefQuality(brief, args.phase, []);
  brief.approvalStatus = "pending";
  return { status: "generated", brief };
}

export function validatePhaseExecutionBrief(brief: PhaseExecutionBrief, phase: WorkflowPhase): PhaseBriefDiagnostic[] {
  const diagnostics: PhaseBriefDiagnostic[] = [];
  const documentationOnly = isDocumentationOnly(phase, brief);
  const concreteReferences = unique([...brief.relevantFiles, ...brief.relevantSymbols, ...brief.writeAreas]);
  const phaseCopies = new Set([
    normalized(phase.objective),
    normalized(phase.rationale),
    normalized(phase.acceptanceCriteria.join(" ")),
    normalized(`Implement the bounded ${phase.id} objective only within its approved read and write areas.`)
  ]);

  if (!brief.objective.trim() || genericText(brief.objective)) diagnostics.push(diagnostic("quality", "objective", "objective.generic", "Objective must identify a specific observable phase outcome."));
  if (
    !brief.deliverable.trim()
    || genericText(brief.deliverable)
    || phaseCopies.has(normalized(brief.deliverable))
    || !containsConcreteReference(brief.deliverable, concreteReferences)
  ) {
    diagnostics.push(diagnostic("quality", "deliverable", "deliverable.not_concrete", "Concrete deliverable must name an affected file, symbol, or bounded artifact and an observable outcome."));
  }
  if (!brief.currentBehaviour?.trim()) diagnostics.push(diagnostic("quality", "currentBehaviour", "current_behaviour.missing", "Current behaviour must be supported by bounded inspection findings."));
  if (
    !brief.implementationApproach.trim()
    || genericText(brief.implementationApproach)
    || phaseCopies.has(normalized(brief.implementationApproach))
    || !actionableApproach(brief.implementationApproach, concreteReferences)
  ) {
    diagnostics.push(diagnostic("quality", "implementationApproach", "approach.not_actionable", "Implementation approach must contain ordered, concrete work tied to inspected files or symbols."));
  }
  if (!documentationOnly && (brief.writeAreas.length === 0 || brief.writeAreas.some((area) => !pathLike(area)))) {
    diagnostics.push(diagnostic("quality", "writeAreas", "scope.missing_write_boundary", "Implementation phases require bounded path-like write areas."));
  }
  if (brief.acceptanceCriteria.length === 0) diagnostics.push(diagnostic("quality", "acceptanceCriteria", "acceptance.missing", "At least one inspectable acceptance criterion is required."));
  if (brief.acceptanceCriteria.some((criterion) => genericCriterion(criterion))) diagnostics.push(diagnostic("quality", "acceptanceCriteria", "acceptance.not_inspectable", "Acceptance criteria must describe observable or verifiable outcomes."));
  if (brief.validationCommands.length === 0 && !brief.manualValidationPlan?.trim()) diagnostics.push(diagnostic("quality", "validationCommands", "validation.missing", "Validation commands or a justified manual validation plan are required."));
  if (brief.testObligations.length === 0) diagnostics.push(diagnostic("quality", "testObligations", "tests.missing", "Relevant test or verification obligations are required."));
  if (!documentationOnly && testsRequired(brief, phase) && !brief.testObligations.some((obligation) => /test|regression|failure|type|schema|compatib|check/i.test(obligation))) {
    diagnostics.push(diagnostic("quality", "testObligations", "tests.unjustified", "Implementation work requires a targeted test or repository-check obligation."));
  }
  if (!Array.isArray(brief.dependencies)) diagnostics.push(diagnostic("quality", "dependencies", "dependencies.missing", "Dependencies must be represented explicitly."));
  if (!Array.isArray(brief.assumptions)) diagnostics.push(diagnostic("quality", "assumptions", "assumptions.missing", "Assumptions must be represented explicitly."));
  if (!Array.isArray(brief.exclusions)) diagnostics.push(diagnostic("quality", "exclusions", "exclusions.missing", "Exclusions must be represented explicitly."));
  if (brief.risks.length === 0) diagnostics.push(diagnostic("quality", "risks", "risks.missing", "Risks must be explicit, including when no additional material risk was found."));
  if (!brief.inspectionResult?.provenance?.source || brief.inspectionResult.filesRead.length === 0) diagnostics.push(diagnostic("quality", "inspectionResult", "inspection.provenance_missing", "Bounded inspection provenance and inspected paths are required."));
  if (!brief.repository?.repositoryRevision || !brief.repository.constraintHash || !brief.repository.inspectionResultId) diagnostics.push(diagnostic("quality", "repository", "repository.provenance_missing", "Repository, constraint, and inspection identities are required."));
  if (brief.workflowRevision < 0 || brief.inspectionRequest.workflowRevision !== brief.workflowRevision) diagnostics.push(diagnostic("quality", "workflowRevision", "revision.mismatch", "Brief and inspection workflow revisions must match the approved Workflow Plan revision."));
  if (concreteReferences.length === 0) {
    diagnostics.push(diagnostic("quality", "relevantFiles", "brief.synthetic_copy", "Brief must add inspected files, symbols, or bounded artifact paths beyond WorkflowPhase prose."));
  } else if (!meaningfullyElaborates(brief, phase)) {
    diagnostics.push(diagnostic("quality", "implementationApproach", "brief.synthetic_copy", "Brief must add inspected evidence and actionable implementation detail beyond WorkflowPhase."));
  }

  return uniqueDiagnostics(diagnostics);
}

export function classifyPhaseBriefChanges(
  phase: WorkflowPhase,
  proposal: PhaseBriefProposal,
  approvedContext: string[] = []
): MaterialPlanChange[] {
  const changes: MaterialPlanChange[] = [];
  const approvedWrites = phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas;
  const outsideWrites = proposal.writeAreas.filter((candidate) => !approvedWrites.some((area) => withinArea(candidate, area)));
  const refinedWrites = proposal.writeAreas.filter((candidate) => !approvedWrites.includes(candidate) && approvedWrites.some((area) => withinArea(candidate, area)));
  if (refinedWrites.length > 0) changes.push(change("file-refinement", phase.id, approvedWrites, refinedWrites, false, "Exact files refine an approved write boundary without expanding it."));
  if (proposal.relevantSymbols.length > 0) changes.push(change("symbol-refinement", phase.id, [], proposal.relevantSymbols, false, "Inspected symbols refine the approved phase implementation target."));
  const narrowedReads = proposal.readAreas.filter((candidate) => phase.expectedReadAreas.some((area) => withinArea(candidate, area)) && !phase.expectedReadAreas.includes(candidate));
  if (narrowedReads.length > 0) changes.push(change("read-boundary", phase.id, phase.expectedReadAreas, narrowedReads, false, "Read paths narrow an approved inspection area."));
  if (outsideWrites.length > 0) changes.push(change("write-boundary", phase.id, approvedWrites, outsideWrites, true, "The brief proposes a write path outside the approved Workflow Plan boundary."));
  if (!sameItems(phase.acceptanceCriteria, proposal.acceptanceCriteria)) {
    const traceabilityRefinement = isScopePreservingAcceptanceRefinement(phase.acceptanceCriteria, proposal.acceptanceCriteria);
    changes.push(change(
      "acceptance-criteria",
      phase.id,
      phase.acceptanceCriteria,
      proposal.acceptanceCriteria,
      !traceabilityRefinement,
      traceabilityRefinement
        ? "The brief preserves each approved requirement and adds observable evidence within the same phase boundary."
        : "The brief changes approved acceptance criteria."
    ));
  }
  const removedValidation = phase.validationCommands.filter((command) => !proposal.validationCommands.includes(command));
  const addedValidation = proposal.validationCommands.filter((command) => !phase.validationCommands.includes(command));
  if (removedValidation.length > 0) {
    changes.push(change("validation", phase.id, phase.validationCommands, proposal.validationCommands, true, "The brief removes or replaces an approved validation requirement."));
  } else if (addedValidation.length > 0) {
    changes.push(change("validation", phase.id, phase.validationCommands, addedValidation, false, "Repository inspection adds configured validation without weakening the approved requirement."));
  }
  if (!sameItems(dependencyIds(phase), proposal.dependencies)) changes.push(change("dependency", phase.id, dependencyIds(phase), proposal.dependencies, true, "The brief changes phase dependencies."));
  const approvedRiskCategories = new Set(canonicalRiskCategories([
    phase.objective,
    phase.rationale,
    phase.riskLevel,
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.expectedFilesOrAreas,
    ...phase.acceptanceCriteria,
    ...phase.validationCommands,
    ...approvedContext
  ].join(" ")));
  for (const discovery of proposal.riskDiscoveries ?? []) {
    if (discovery.source !== "inspection" || discovery.evidence.length === 0) continue;
    for (const category of canonicalRiskCategories(discovery.risk)) {
      if (approvedRiskCategories.has(category)) continue;
      changes.push(change(
        "risk",
        phase.id,
        [phase.riskLevel],
        [discovery.risk],
        true,
        `Inspection evidence identified a new ${category} risk outside the approved Workflow Plan context.`
      ));
    }
  }
  return changes;
}

function deterministicProposal(input: PhaseBriefPlanningInput): PhaseBriefProposal {
  const { state, phase, inspection } = input;
  const relevantFiles = unique([...inspection.relevantFiles, ...concretePlannedTargets(phase)]);
  const relevantSymbols = unique(inspection.relevantSymbols);
  const writeAreas = refineWriteAreas(phase, relevantFiles);
  const readAreas = unique([...phase.expectedReadAreas, ...inspection.filesRead.filter((file) => !writeAreas.includes(file))]);
  const primaryTargets = unique([...relevantSymbols.slice(0, 4), ...writeAreas.slice(0, 4), ...relevantFiles.slice(0, 4)]);
  const targetSummary = primaryTargets.join(", ") || phase.id;
  const currentBehaviour = inspection.findings.find((finding) => finding.questionId === "implementation")?.answer
    ?? `No existing implementation was found within the approved paths; ${writeAreas.join(", ")} is the bounded creation target.`;
  const prior = priorPhaseContext(state, phase);
  const validationCommands = phaseScopedValidationCommands(
    unique([...phase.validationCommands, ...inspection.validationCommands]),
    writeAreas
  );
  const documentationOnly = state.triage?.task.type === "documentation" || writeAreas.every((area) => /(^|\/)(docs?|readme)/i.test(area));
  const testObligations = deriveTestObligations(state, phase, inspection, documentationOnly);
  const constraints = effectiveConstraints(state);
  const approachSteps = [
    `1. Use the inspected current-behaviour evidence in ${relevantFiles.slice(0, 5).join(", ") || writeAreas.join(", ")} to confirm the exact change point${relevantSymbols.length > 0 ? ` (${relevantSymbols.slice(0, 5).join(", ")})` : ""}.`,
    `2. Modify only ${writeAreas.join(", ")} to deliver ${phase.objective.toLowerCase()}, preserving the approved constraints and existing contracts identified by inspection.`,
    `3. ${documentationOnly ? "Verify links, examples, and rendered documentation expectations" : `Add or update the targeted verification described by: ${testObligations.join("; ")}`}.`,
    `4. Run ${validationCommands.join(", ") || "the documented manual validation plan"} and compare the result with every acceptance criterion before reporting completion.`
  ];
  if (input.feedback) approachSteps.splice(1, 0, `Revision feedback to apply: ${input.feedback.trim()}`);

  return {
    objective: phase.objective,
    deliverable: `A bounded update to ${writeAreas.join(", ") || targetSummary} that makes ${phase.objective.toLowerCase()} observable and verifiable through ${validationCommands.join(", ") || "the recorded manual validation plan"}.`,
    currentBehaviour: prior ? `${currentBehaviour} ${prior}` : currentBehaviour,
    implementationApproach: approachSteps.join("\n"),
    readAreas,
    writeAreas,
    relevantFiles,
    relevantSymbols,
    dependencies: dependencyIds(phase),
    assumptions: unique([...(state.triage?.assumptions ?? []), ...priorPhaseAssumptions(state, phase)]),
    exclusions: constraints,
    acceptanceCriteria: synthesizeObservableAcceptanceCriteria(phase.acceptanceCriteria, {
      validationCommands,
      documentationOnly
    }),
    testObligations,
    validationCommands,
    manualValidationPlan: validationCommands.length === 0 ? manualValidationPlan(documentationOnly, relevantFiles) : undefined,
    risks: deriveRisks(state, phase, inspection),
    riskDiscoveries: []
  };
}

function assembleBrief(args: {
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  previous?: PhaseExecutionBrief;
  feedback?: string;
  proposal: PhaseBriefProposal;
  provider: string;
  modelTier: ModelTier;
  warnings: string[];
  request: PhaseExecutionBrief["inspectionRequest"];
  inspection: PhaseExecutionBrief["inspectionResult"];
  repository: PhaseExecutionBrief["repository"];
  workflowRevision: number;
  briefRevision: number;
  repairAttempts: number;
}): PhaseExecutionBrief {
  const now = new Date().toISOString();
  const revisionRequests = [
    ...(args.previous?.revisionRequests ?? []),
    ...(args.feedback ? [{ feedback: args.feedback.trim(), timestamp: now }] : [])
  ];
  const riskDiscoveries = normalizeRiskDiscoveries(args.proposal.riskDiscoveries);
  const proposal = {
    ...structuredClone(args.proposal),
    validationCommands: phaseScopedValidationCommands(args.proposal.validationCommands, args.proposal.writeAreas),
    risks: unique([...args.proposal.risks, ...riskDiscoveries.map((discovery) => discovery.risk)]),
    riskDiscoveries
  };
  const materialChangesFromWorkflowPlan = classifyPhaseBriefChanges(
    args.phase,
    proposal,
    approvedPhaseRiskContext(args.state, args.phase)
  );
  return {
    phaseId: args.phase.id,
    workflowRevision: args.workflowRevision,
    briefRevision: args.briefRevision,
    generatedAt: now,
    ...proposal,
    provider: args.provider,
    modelTier: args.modelTier,
    inspectionRequest: args.request,
    inspectionResult: args.inspection,
    repository: args.repository,
    generation: {
      source: args.provider === "deterministic-phase-brief" ? "deterministic" : "provider",
      provider: args.provider,
      modelTier: args.modelTier,
      warnings: args.warnings
    },
    validation: {
      status: "blocked",
      diagnostics: [],
      repairAttempts: args.repairAttempts,
      validatedAt: now
    },
    revisionRequests,
    materialChangesFromWorkflowPlan,
    approvalStatus: "pending"
  };
}

function blockedFailure(args: {
  phase: WorkflowPhase;
  workflowRevision: number;
  briefRevision: number;
  status: PhaseBriefGenerationFailure["status"];
  message: string;
  diagnostics: PhaseBriefDiagnostic[];
  request: PhaseBriefGenerationFailure["inspectionRequest"];
  result?: PhaseBriefGenerationFailure["inspectionResult"];
  repairAttempts: number;
  provider: string;
  modelTier: ModelTier;
  recoveryAttempts: ArtifactRecoveryAttempt[];
  quality?: PhaseExecutionBrief["quality"];
}): PhaseBriefGenerationOutcome {
  const ownership = classifyPhaseBriefFailure(args.status, args.diagnostics);
  return {
    status: "blocked",
    failure: {
      phaseId: args.phase.id,
      workflowRevision: args.workflowRevision,
      briefRevision: args.briefRevision,
      status: args.status,
      message: args.message,
      diagnostics: args.diagnostics,
      inspectionRequest: args.request,
      inspectionResult: args.result,
      repairAttempts: args.repairAttempts,
      provider: args.provider,
      modelTier: args.modelTier,
      failureOwnership: ownership,
      recoveryAttempts: args.recoveryAttempts,
      quality: args.quality,
      failedAt: new Date().toISOString()
    }
  };
}

function mergeDiagnosedFields(original: PhaseBriefProposal, repaired: PhaseBriefProposal, diagnostics: PhaseBriefDiagnostic[]): PhaseBriefProposal {
  const merged = structuredClone(original);
  for (const field of new Set(diagnostics.map((item) => item.field))) copyProposalField(merged, repaired, field);
  return merged;
}

function copyProposalField(target: PhaseBriefProposal, source: PhaseBriefProposal, field: string): void {
  if (field in target && field in source) {
    (target as unknown as Record<string, unknown>)[field] = structuredClone((source as unknown as Record<string, unknown>)[field]);
  }
}

function proposalFromBrief(brief: PhaseExecutionBrief): PhaseBriefProposal {
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

function refineWriteAreas(phase: WorkflowPhase, relevantFiles: string[]): string[] {
  const approved = phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas;
  const refinements = relevantFiles.filter((file) => approved.some((area) => withinArea(file, area)) && !isMetadata(file));
  return unique(refinements.length > 0 ? refinements : approved);
}

function concretePlannedTargets(phase: WorkflowPhase): string[] {
  return unique([...phase.expectedWriteAreas, ...phase.expectedFilesOrAreas].filter((area) => pathLike(area) && !/[*?[{]/.test(area)));
}

function deriveTestObligations(
  state: SequentialWorkflowState,
  phase: WorkflowPhase,
  inspection: PhaseBriefInspectionResult,
  documentationOnly: boolean
): string[] {
  if (documentationOnly) return ["Verify documentation links, examples, and rendered structure against the acceptance criteria."];
  const obligations: string[] = [];
  const taskType = state.triage?.task.type;
  if (taskType === "bug") obligations.push(`Add or update a targeted regression test for: ${phase.objective}.`);
  else obligations.push(`Exercise the affected behaviour for: ${phase.objective}.`);
  const text = `${state.request} ${phase.objective} ${inspection.relevantFiles.join(" ")}`.toLowerCase();
  if (/schema|type|interface|contract|api/.test(text)) obligations.push("Run schema/type validation and preserve the inspected public or internal contract.");
  if (/compatib|migration/.test(text)) obligations.push("Verify compatibility loading or migration behaviour, including the existing-state path.");
  if (state.mode === "rigorous" || phase.riskLevel === "high") obligations.push("Cover a relevant failure path or rejected-input path.");
  for (const command of unique([...phase.validationCommands, ...inspection.validationCommands])) obligations.push(`Run configured check: ${command}.`);
  return unique(obligations);
}

export function synthesizeObservableAcceptanceCriteria(
  criteria: string[],
  context: { validationCommands?: string[]; documentationOnly?: boolean } = {}
): string[] {
  const validation = context.validationCommands?.[0];
  return criteria.map((criterion) => {
    const requirement = criterion.trim().replace(/[.!]+$/, "");
    if (!needsEvidenceSynthesis(criterion)) return criterion.trim();
    const category = classifyAcceptanceOutcome(requirement, context.documentationOnly);
    const evidence = observableEvidenceFor(category, validation);
    return `${requirement}. ${evidence}`;
  });
}

export function classifyAcceptanceOutcome(
  criterion: string,
  documentationOnly = false
): AcceptanceOutcomeCategory {
  const value = criterion.toLowerCase();
  if (documentationOnly || /\b(documentation|docs?|readme|guide|example|link)\b/.test(value)) return "documentation";
  if (/\b(plan(?:ning)?|policy|rule|obligations?|coverage categor|requirement classification)\b/.test(value)) return "validation";
  if (/\b(backward|forward|compatib|legacy|existing state|existing workflows?|remain(?:s)? loadable|previous(?:ly)? persisted|old state)\b/.test(value)) return "compatibility";
  if (/\b(save|load|persist(?:s|ed|ence|ent|ing)?|round[- ]?trip|stored|storage|serialize|deserialize)\b/.test(value)) return "persistence";
  if (/\b(migrat|rollback|forward[- ]?fix|versioned data)\b/.test(value)) return "migration";
  if (/\b(cli|command[- ]?line|stdout|stderr|exit code|terminal output)\b/.test(value)) return "cli";
  if (/\b(workflow state|state transition|lifecycle|status transition)\b/.test(value)) return "workflow-state";
  if (/\b(reject|prevent|block|invalid|failure|error|malformed|unavailable|timeout|missing required)\b/.test(value)) return "failure-handling";
  if (/\b(schema|serializ|deserializ|field|required|optional|enum|type shape|interface|property)\b/.test(value)) return "schema";
  if (/\b(public|api|contract|consumer|protocol)\b/.test(value)) return "public-contract";
  if (/\b(security|auth|permission|credential|secret|access control)\b/.test(value)) return "security";
  if (/\b(concurr|idempoten|race|parallel|locking|lease)\b/.test(value)) return "concurrency";
  if (/\b(integrat|end[- ]to[- ]end|combined|consumer)\b/.test(value)) return "integration";
  return "validation";
}

function needsEvidenceSynthesis(criterion: string): boolean {
  if (genericCriterion(criterion)) return true;
  return !/\b(test|check|command|invocation|output|exit code|result|evidence|inspect|load(?:s|ed)?|save(?:s|d)?|round[- ]?trip|serialize[sd]?|deserialize[sd]?|pass(?:es|ed)?|fail(?:s|ed)?|reject(?:s|ed)?|return(?:s|ed)?|render(?:s|ed)?|emit(?:s|ted)?)\b/i.test(criterion);
}

export function isObservableAcceptanceCriterion(criterion: string): boolean {
  return !needsEvidenceSynthesis(criterion);
}

function observableEvidenceFor(category: AcceptanceOutcomeCategory, validation?: string): string {
  const check = validation ? ` and '${validation}' passes` : "";
  switch (category) {
    case "persistence":
      return `A focused round-trip check saves and reloads representative state with the required values unchanged${check}.`;
    case "compatibility":
      return `A compatibility check loads a representative previously persisted state and preserves its observable behaviour${check}.`;
    case "schema":
      return `A focused schema or type-contract check accepts a representative valid value and rejects a malformed or incomplete value predictably${check}.`;
    case "public-contract":
      return `A focused contract check exercises the affected consumer-visible behaviour and records the returned value or emitted representation${check}.`;
    case "cli":
      return `A focused command invocation records its exit code and expected standard output or error output${check}.`;
    case "workflow-state":
      return `A focused transition check records the starting state, action, and deterministic resulting state${check}.`;
    case "failure-handling":
      return `A focused failure-path check supplies invalid or unavailable input and records the predictable rejection or error result${check}.`;
    case "migration":
      return `A focused migration check records the before and after representation and verifies the supported rollback or forward-fix path${check}.`;
    case "security":
      return `A focused policy check records an allowed case and a denied case without exposing protected data${check}.`;
    case "concurrency":
      return `A focused repeated or concurrent operation check records a stable, non-duplicated result${check}.`;
    case "integration":
      return `A focused integration check exercises the producing and consuming boundaries together and records the observable result${check}.`;
    case "documentation":
      return `A documentation check verifies the affected links, examples, and rendered structure against the implemented behaviour${check}.`;
    case "validation":
      return `A focused repository check exercises this requirement and records a passing result tied to the criterion${check}.`;
  }
}

function isScopePreservingAcceptanceRefinement(approved: string[], proposed: string[]): boolean {
  if (approved.length !== proposed.length) return false;
  return approved.every((criterion, index) => {
    const requirement = normalized(criterion);
    const candidate = normalized(proposed[index] ?? "");
    return candidate === requirement || candidate.startsWith(`${requirement}. `) || candidate.startsWith(`${requirement} `);
  });
}

function deriveRisks(state: SequentialWorkflowState, phase: WorkflowPhase, inspection: PhaseBriefInspectionResult): string[] {
  const risks: string[] = [];
  const text = `${state.request} ${phase.objective} ${phase.rationale}`.toLowerCase();
  const categories = new Set(canonicalRiskCategories(text));
  if (categories.has("security")) risks.push("Security-sensitive behaviour must preserve authentication, authorization, and credential boundaries.");
  if (categories.has("migration")) risks.push("Migration or schema compatibility must be preserved for existing state.");
  if (categories.has("public-contract")) risks.push("Public-contract behaviour may affect downstream consumers.");
  if (inspection.unresolvedQuestions.length > 0) risks.push(`Bounded inspection left unresolved questions: ${inspection.unresolvedQuestions.join("; ")}.`);
  if (phase.riskLevel !== "none") risks.push(`${phase.riskLevel} phase risk remains subject to the approved Workflow Plan controls.`);
  if (risks.length === 0) risks.push("No additional material risk was found by bounded inspection.");
  return unique(risks);
}

function approvedPhaseRiskContext(state: SequentialWorkflowState, phase: WorkflowPhase): string[] {
  return unique([
    state.request,
    state.plan?.summary ?? "",
    ...(state.plan?.principles ?? []),
    phase.objective,
    phase.rationale,
    ...phase.acceptanceCriteria,
    ...phase.validationCommands,
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.expectedFilesOrAreas,
    ...effectiveConstraints(state),
    ...(state.triage?.assumptions ?? []),
    ...priorPhaseAssumptions(state, phase)
  ]);
}

function normalizeRiskDiscoveries(discoveries: PhaseBriefRiskDiscovery[] | undefined): PhaseBriefRiskDiscovery[] {
  const normalizedDiscoveries = (discoveries ?? [])
    .filter((discovery) => discovery.source === "inspection")
    .map((discovery) => ({
      risk: discovery.risk.trim(),
      categories: canonicalRiskCategories(discovery.risk),
      evidence: unique(discovery.evidence),
      source: discovery.source
    }))
    .filter((discovery) => discovery.risk.length > 0 && discovery.categories.length > 0 && discovery.evidence.length > 0);
  const seen = new Set<string>();
  return normalizedDiscoveries.filter((discovery) => {
    const key = stableHash(discovery);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function priorPhaseContext(state: SequentialWorkflowState, phase: WorkflowPhase): string | undefined {
  const prior = relevantPriorPhases(state, phase);
  if (prior.length === 0) return undefined;
  return `Prior completed phase evidence: ${prior.map((candidate) => `${candidate.id} changed ${candidate.filesChanged.join(", ") || "no recorded files"} and concluded ${candidate.completion?.reason ?? "completed"}`).join("; ")}.`;
}

function priorPhaseAssumptions(state: SequentialWorkflowState, phase: WorkflowPhase): string[] {
  return relevantPriorPhases(state, phase).flatMap((candidate) => candidate.completion?.assumptions.map((assumption) => `From ${candidate.id}: ${assumption}`) ?? []);
}

function relevantPriorPhases(state: SequentialWorkflowState, phase: WorkflowPhase): WorkflowPhase[] {
  const dependencies = new Set(dependencyIds(phase));
  return (state.plan?.phases ?? []).filter((candidate) => candidate.status === "completed" && (dependencies.has(candidate.id) || candidate.completedAt));
}

function effectiveConstraints(state: SequentialWorkflowState): string[] {
  return unique(state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot ?? []);
}

function manualValidationPlan(documentationOnly: boolean, files: string[]): string {
  return documentationOnly
    ? `Review links, examples, headings, and rendered formatting in ${files.join(", ") || "the approved documentation files"}.`
    : `Inspect the changed behaviour in ${files.join(", ") || "the approved write paths"} against every acceptance criterion and record evidence for each result.`;
}

function isDocumentationOnly(phase: WorkflowPhase, brief: Pick<PhaseExecutionBrief, "writeAreas">): boolean {
  const areas = brief.writeAreas.length > 0
    ? brief.writeAreas
    : phase.expectedWriteAreas.length > 0
      ? phase.expectedWriteAreas
      : phase.expectedFilesOrAreas;
  return areas.length > 0 && areas.every((area) => /(^|\/)(docs?|readme)/i.test(area));
}

function testsRequired(brief: PhaseExecutionBrief, phase: WorkflowPhase): boolean {
  return !isDocumentationOnly(phase, brief) && !brief.risks.every((risk) => /no additional material risk/i.test(risk));
}

function actionableApproach(value: string, references: string[]): boolean {
  const actions = value.match(/\b(inspect|locate|modify|update|preserve|add|verify|run|compare|record|create|remove)\b/gi) ?? [];
  return actions.length >= 3 && containsConcreteReference(value, references) && (value.includes("\n") || /\bthen\b|\bafter\b|\bfirst\b/i.test(value));
}

function meaningfullyElaborates(brief: PhaseExecutionBrief, phase: WorkflowPhase): boolean {
  return normalized(brief.deliverable) !== normalized(phase.acceptanceCriteria.join(" "))
    && normalized(brief.currentBehaviour ?? "") !== normalized(phase.rationale)
    && brief.implementationApproach.split("\n").length >= 3
    && (brief.relevantFiles.length > 0 || brief.relevantSymbols.length > 0);
}

function containsConcreteReference(value: string, references: string[]): boolean {
  const lower = value.toLowerCase();
  return references.some((reference) => lower.includes(reference.toLowerCase()));
}

function genericText(value: string): boolean {
  const normalizedValue = normalized(value);
  return [
    "implement the feature",
    "implement this phase",
    "update relevant files",
    "add tests",
    "run validation",
    "make the change"
  ].some((generic) => normalizedValue === generic || normalizedValue.startsWith(`${generic} only`));
}

function genericCriterion(value: string): boolean {
  return value.trim().length < 16
    || genericText(value)
    || !/\b(pass(?:es|ed)?|fail(?:s|ed)?|return(?:s|ed)?|render(?:s|ed)?|persist(?:s|ed)?|reject(?:s|ed)?|accept(?:s|ed)?|contain(?:s|ed)?|match(?:es|ed)?|remain(?:s|ed)?|load(?:s|ed|able)?|compatible|unchanged|creat(?:e|es|ed)|updat(?:e|es|ed)|remov(?:e|es|ed)|prevent(?:s|ed)?|allow(?:s|ed)?|record(?:s|ed)?|show(?:s|ed)?|produc(?:e|es|ed)|complet(?:e|es|ed)|explicit|reviewable|verifiable|observable)\b/i.test(value);
}

function pathLike(value: string): boolean {
  return isRepositoryPathPattern(value);
}

function withinArea(candidate: string, area: string): boolean {
  const normalizedCandidate = slash(candidate).replace(/^\.\//, "");
  const normalizedArea = slash(area).replace(/^\.\//, "");
  if (normalizedArea === normalizedCandidate) return true;
  const wildcard = normalizedArea.search(/[*?[{]/);
  const base = (wildcard >= 0 ? normalizedArea.slice(0, wildcard) : normalizedArea).replace(/\/+$/, "");
  return Boolean(base) && (normalizedCandidate === base || normalizedCandidate.startsWith(`${base}/`));
}

function change(
  category: MaterialPlanChange["category"],
  phaseId: string,
  previousValue: string[],
  proposedValue: string[],
  material: boolean,
  reason: string
): MaterialPlanChange {
  return {
    category,
    previousValue,
    proposedValue,
    affectedPhase: phaseId,
    severity: material ? "high" : "informational",
    material,
    reason,
    requiredTransition: material ? "revise-plan" : "none"
  };
}

function diagnostic(
  stage: PhaseBriefDiagnostic["stage"],
  field: string,
  code: string,
  message: string,
  repairAttempt: PhaseBriefDiagnostic["repairAttempt"] = "none"
): PhaseBriefDiagnostic {
  return { stage, field, code, message, repairAttempt, resolution: "unresolved" };
}

function uniqueDiagnostics(values: PhaseBriefDiagnostic[]): PhaseBriefDiagnostic[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.stage}:${value.field}:${value.code}:${value.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isMetadata(file: string): boolean {
  return ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"].includes(file);
}

function sameItems(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function phaseBriefInspectionIdentity(result: PhaseBriefInspectionResult): string {
  const stableResult: Partial<PhaseBriefInspectionResult> = { ...result };
  delete stableResult.completedAt;
  return stableHash(stableResult);
}

function recoveryFeedback(
  feedback: string | undefined,
  diagnostics: PhaseBriefDiagnostic[],
  strategy: string
): string {
  const diagnosis = diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
  return [feedback?.trim(), strategy, `Diagnosed quality failures: ${diagnosis}`].filter(Boolean).join("\n");
}

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function phaseScopedValidationCommands(commands: string[], writeAreas: string[]): string[] {
  if (ownsReleaseVersionSurface(writeAreas)) return unique(commands);
  return unique(commands).filter((command) => !isReleaseVersionGate(command));
}

function ownsReleaseVersionSurface(writeAreas: string[]): boolean {
  const requiredPaths = [
    "package.json",
    "package-lock.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "src/cli/index.ts"
  ];
  return requiredPaths.every((file) => writeAreas.some((area) => pathAreaContains(area, file)));
}

function isReleaseVersionGate(command: string): boolean {
  return /\bnpm\s+run\s+(?:check:plugin-version-bump|version:(?:dev|sync))\b/i.test(command)
    || /\bnpm\s+version\b/i.test(command);
}

function pathAreaContains(area: string, file: string): boolean {
  const normalizedArea = area.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "").replace(/\/\*\*.*$/, "").replace(/\/\*.*$/, "");
  return normalizedArea === file || (normalizedArea.length > 0 && file.startsWith(`${normalizedArea}/`));
}
