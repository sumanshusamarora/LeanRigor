import { createHash } from "node:crypto";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import { dependencyIds } from "./scheduler.js";
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
import type {
  MaterialPlanChange,
  PhaseBriefDiagnostic,
  PhaseBriefGenerationFailure,
  PhaseBriefInspectionResult,
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
}

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
  const provider = args.provider ?? new DeterministicPhaseBriefPlanningProvider();
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
      modelTier: tier
    });
  }

  const input: PhaseBriefPlanningInput = {
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
    return blockedFailure({
      phase: args.phase,
      workflowRevision: planRevision,
      briefRevision: initialBriefRevision,
      status: "quality-blocked",
      message: `${args.phase.id} brief-planning provider failed: ${messageOf(error)}`,
      diagnostics: [diagnostic("generation", "brief", "generation.provider_failed", messageOf(error))],
      request: inspected.request,
      result: inspected.result,
      repairAttempts: 0,
      provider: provider.name,
      modelTier: tier
    });
  }

  const repo = await repositoryRevision(args.state.root);
  const constraintHash = stableHash(effectiveConstraints(args.state));
  const inspectionResultId = stableHash(inspected.result);
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
    } catch (error) {
      diagnostics.push(diagnostic("generation", "brief", "repair.provider_failed", messageOf(error), "same-provider"));
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
      request: inspected.request,
      result: inspected.result,
      repairAttempts: brief.validation.repairAttempts,
      provider: brief.generation.provider,
      modelTier: brief.generation.modelTier
    });
  }

  brief.validation = {
    status: "valid",
    diagnostics: brief.validation.diagnostics,
    repairAttempts: brief.validation.repairAttempts,
    validatedAt: new Date().toISOString()
  };
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
  if (!sameItems(phase.acceptanceCriteria, proposal.acceptanceCriteria)) changes.push(change("acceptance-criteria", phase.id, phase.acceptanceCriteria, proposal.acceptanceCriteria, true, "The brief changes approved acceptance criteria."));
  const removedValidation = phase.validationCommands.filter((command) => !proposal.validationCommands.includes(command));
  const addedValidation = proposal.validationCommands.filter((command) => !phase.validationCommands.includes(command));
  if (removedValidation.length > 0) {
    changes.push(change("validation", phase.id, phase.validationCommands, proposal.validationCommands, true, "The brief removes or replaces an approved validation requirement."));
  } else if (addedValidation.length > 0) {
    changes.push(change("validation", phase.id, phase.validationCommands, addedValidation, false, "Repository inspection adds configured validation without weakening the approved requirement."));
  }
  if (!sameItems(dependencyIds(phase), proposal.dependencies)) changes.push(change("dependency", phase.id, dependencyIds(phase), proposal.dependencies, true, "The brief changes phase dependencies."));
  const approvedRiskText = [
    phase.objective,
    phase.rationale,
    phase.riskLevel,
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.expectedFilesOrAreas,
    ...approvedContext
  ].join(" ").toLowerCase();
  const newlyMaterialRisks = proposal.risks.filter((risk) =>
    !risk.startsWith("Bounded inspection left unresolved questions:")
    && /security|migration|architecture|public contract/i.test(risk)
    && !riskTerms(risk).some((term) => approvedRiskText.includes(term)));
  if (newlyMaterialRisks.length > 0) changes.push(change("risk", phase.id, [phase.riskLevel], newlyMaterialRisks, true, "Inspection identified a new material security, migration, architecture, or contract risk."));
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
  const validationCommands = unique([...phase.validationCommands, ...inspection.validationCommands]);
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
    acceptanceCriteria: [...phase.acceptanceCriteria],
    testObligations,
    validationCommands,
    manualValidationPlan: validationCommands.length === 0 ? manualValidationPlan(documentationOnly, relevantFiles) : undefined,
    risks: deriveRisks(state, phase, inspection)
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
  const materialChangesFromWorkflowPlan = classifyPhaseBriefChanges(args.phase, args.proposal, [
    args.state.request,
    args.state.plan?.summary ?? "",
    ...(args.state.plan?.principles ?? [])
  ]);
  return {
    phaseId: args.phase.id,
    workflowRevision: args.workflowRevision,
    briefRevision: args.briefRevision,
    generatedAt: now,
    ...structuredClone(args.proposal),
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
}): PhaseBriefGenerationOutcome {
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
    risks: [...brief.risks]
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

function deriveRisks(state: SequentialWorkflowState, phase: WorkflowPhase, inspection: PhaseBriefInspectionResult): string[] {
  const risks: string[] = [];
  const text = `${state.request} ${phase.objective} ${phase.rationale}`.toLowerCase();
  if (/security|auth|credential|permission/.test(text)) risks.push("Security-sensitive behaviour must preserve authentication, authorization, and credential boundaries.");
  if (/migration|schema/.test(text)) risks.push("Migration or schema compatibility must be preserved for existing state.");
  if (/public|api|contract/.test(text)) risks.push("Public-contract behaviour may affect downstream consumers.");
  if (inspection.unresolvedQuestions.length > 0) risks.push(`Bounded inspection left unresolved questions: ${inspection.unresolvedQuestions.join("; ")}.`);
  if (phase.riskLevel !== "none") risks.push(`${phase.riskLevel} phase risk remains subject to the approved Workflow Plan controls.`);
  if (risks.length === 0) risks.push("No additional material risk was found by bounded inspection.");
  return unique(risks);
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
  return value.includes("/") || /(^|\/)(readme|makefile)$/i.test(value) || /\.[a-z0-9]+$/i.test(value);
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
    requiredTransition: material ? "reapprove-plan" : "none"
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

function riskTerms(value: string): string[] {
  return value.toLowerCase().match(/security|migration|architecture|contract|schema|auth/g) ?? [];
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

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
