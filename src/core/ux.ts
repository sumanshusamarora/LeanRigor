import { listFlows, nextActions, resumeFlow } from "./flow.js";
import { approvalRecommendation } from "./approval.js";
import { workflowDecisionEnvelope } from "./workflow-envelope.js";
import type { CommitPlan, SequentialWorkflowState, WorkflowDecisionEnvelope, WorkflowLifecycleState, WorkflowMode, WorkflowPhase } from "./types.js";

export interface WorkflowListSummary {
  id: string;
  request: string;
  state: WorkflowLifecycleState;
  mode: WorkflowMode;
  updatedAt: string;
}

export interface ActiveWorkflowSelection {
  status: "none" | "one" | "multiple";
  workflow?: WorkflowListSummary;
  workflows: WorkflowListSummary[];
  message: string;
}

export interface ApprovalAction {
  label: string;
  intent: string;
  command: string;
  description: string;
}

export interface WorkflowNextSummary {
  workflow: WorkflowListSummary;
  decisionEnvelope: WorkflowDecisionEnvelope;
  label: string;
  userDecisionRequired: boolean;
  pendingDecision: string | null;
  pendingAction: string;
  allowedIntents: string[];
  approvalActions?: ApprovalAction[];
  summary: Record<string, unknown>;
  troubleshooting: {
    showCommandsOnlyOnFailure: true;
    internalOperations: string[];
  };
}

export async function activeWorkflowSelection(root: string): Promise<ActiveWorkflowSelection> {
  const flows = (await listFlows(root)).filter((flow) => !["completed", "cancelled"].includes(flow.state));
  const workflows = flows.map((flow) => ({
    id: flow.id,
    request: flow.request,
    state: flow.state,
    mode: flow.mode,
    updatedAt: flow.updatedAt
  }));
  if (workflows.length === 0) {
    return { status: "none", workflows, message: "No active LeanRigor workflow exists in this repository." };
  }
  if (workflows.length === 1) {
    return { status: "one", workflow: workflows[0], workflows, message: "One active LeanRigor workflow is available." };
  }
  return { status: "multiple", workflows, message: "Multiple active LeanRigor workflows require user selection." };
}

export async function resolveSingleActiveWorkflow(root: string): Promise<SequentialWorkflowState> {
  const selection = await activeWorkflowSelection(root);
  if (selection.status === "none") throw new Error("No active LeanRigor workflow exists. Start one with a request.");
  if (selection.status === "multiple") throw new Error("Multiple active LeanRigor workflows exist. Choose a workflow ID before continuing.");
  if (!selection.workflow) throw new Error("Active workflow selection is missing workflow details.");
  return resumeFlow(root, selection.workflow.id);
}

export function workflowNextSummary(state: SequentialWorkflowState): WorkflowNextSummary {
  const workflow = workflowListSummary(state);
  const phase = currentPhaseObject(state);
  const base = {
    workflow,
    decisionEnvelope: workflowDecisionEnvelope(state),
    troubleshooting: {
      showCommandsOnlyOnFailure: true as const,
      internalOperations: internalOperationsFor(state)
    }
  };

  if (state.state === "awaiting_clarification") {
    const question = state.clarification?.question ?? "What specific behaviour should change?";
    const reason = state.clarification?.reason;
    return {
      ...base,
      label: "Clarification",
      userDecisionRequired: true,
      pendingDecision: "Answer the single blocking clarification question.",
      pendingAction: question,
      allowedIntents: ["answer", "cancel", "show status"],
      summary: {
        question,
        reason,
        modeStatus: "provisional",
        provisionalRecommendation: state.triage?.workflow.modelRecommendation ?? workflow.mode,
        finalMode: null,
        clarificationDecision: state.triage?.clarificationDecision
      }
    };
  }
  if (state.state === "awaiting_approach_approval") {
    const root = quoteArg(state.root);
    return {
      ...base,
      label: "Approach approval",
      userDecisionRequired: true,
      pendingDecision: "Choose the next post-triage action. No implementation has started.",
      pendingAction: "Select an action. Approval is required before planning can begin.",
      allowedIntents: ["approve", "looks good", "continue", "revise", "view details", "show status", "cancel"],
      approvalActions: [
        { label: "Approve approach and create plan", intent: "approve", command: `leanrigor flow approve-approach ${state.id} --provider auto --root ${root}`, description: "Continue to model-assisted planning using the approved triage constraints." },
        { label: "Revise approach", intent: "revise", command: `leanrigor flow revise-approach ${state.id} "<feedback>" --root ${root}`, description: "Let me provide changes or additional constraints before planning." },
        { label: "View workflow details", intent: "view details", command: `leanrigor flow status ${state.id} --root ${root}`, description: "Show full triage, policy, provenance, and current workflow state." },
        { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${root}`, description: "Stop this workflow without starting implementation." }
      ],
      summary: {
        task: state.triage?.task,
        assessment: state.triage?.assessment,
        constraints: state.constraints ?? state.triage?.constraints,
        escalationReasons: state.triage?.escalationReasons ?? [],
        assumptions: state.triage?.assumptions ?? [],
        warnings: state.triageRun?.warnings ?? [],
        proposed: state.approach?.proposed,
        preferredBecause: state.approach?.preferredBecause,
        risks: state.approach?.primaryRisks ?? [],
        validation: state.approach?.validationStrategy ?? [],
        revisionRequests: state.approach?.revisionRequests ?? [],
        noImplementationStarted: true
      }
    };
  }
  if (state.state === "awaiting_plan_approval") {
    const plan = state.plan;
    const readiness = planExecutionStructure(state);
    const recommendation = state.approval?.recommendation ?? approvalRecommendation(state);
    const root = quoteArg(state.root);
    const executionActions: ApprovalAction[] = state.mode === "rigorous"
      ? [{ label: "Approve Workflow Plan and prepare Phase 1 brief", intent: "approve", command: `leanrigor flow approve-plan ${state.id} --approval-policy phase-by-phase --root ${root}`, description: "Approve the Workflow Plan only, then review the separate Phase 1 Execution Brief before any execution." }]
      : [
        { label: "Approve Workflow Plan and prepare Phase 1 brief", intent: "approve", command: `leanrigor flow approve-plan ${state.id} --approval-policy workflow-authorized --root ${root}`, description: "Approve the Workflow Plan policy, then review Phase 1's separate brief before execution." },
        { label: "Approve Workflow Plan with phase-by-phase review", intent: "approve", command: `leanrigor flow approve-plan ${state.id} --approval-policy phase-by-phase --root ${root}`, description: "Approve the Workflow Plan and require a separate brief approval before every phase." }
      ];
    return {
      ...base,
      label: "Plan approval",
      userDecisionRequired: true,
      pendingDecision: "Approve this Workflow Plan, request changes, or cancel.",
      pendingAction: "Select an approval action or type a response.",
      allowedIntents: ["approve", "looks good", "continue", "revise", "cancel", "show status", "show plan"],
      approvalActions: [
        ...executionActions,
        { label: "Revise plan", intent: "revise", command: `leanrigor flow revise-plan ${state.id} "<feedback>" --root ${root}`, description: "Request Workflow Plan changes with specific feedback." },
        { label: "View full details", intent: "show plan", command: `leanrigor flow status ${state.id} --json --root ${quoteArg(state.root)}`, description: "Show full persisted workflow, plan, constraints, and provenance." },
        { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${quoteArg(state.root)}`, description: "Cancel this workflow." }
      ],
      summary: {
        workflow: {
          id: state.id,
          mode: state.mode,
          planningSource: state.planningRun?.source ?? "unknown",
          provider: state.planningRun?.provider ?? "unknown",
          model: state.planningRun?.model,
          attemptRecords: state.planningRun?.attemptRecords ?? [],
          planningOutcome: planningOutcomeExplanation(state),
          phases: plan?.phases.length ?? 0
        },
        overallStrategy: {
          implementationDivision: plan?.summary ?? "Sequential implementation plan.",
          orderRationale: "Dependencies define execution order; each phase is independently reviewable before dependents unlock.",
          architectureBoundaries: unique(plan?.phases.flatMap((phase) => phase.expectedWriteAreas.map(architectureBoundaryForArea)) ?? []).filter(Boolean)
        },
        phases: plan?.phases.map((candidate, index) => ({
          number: index + 1,
          id: candidate.id,
          objective: candidate.objective,
          rationale: candidate.rationale,
          dependencies: candidate.dependencies,
          expectedWriteAreas: candidate.expectedWriteAreas,
          riskLevel: candidate.riskLevel,
          modelTier: candidate.modelTier,
          status: candidate.status,
          validation: candidate.validationCommands
        })) ?? [],
        executionStructure: readiness,
        validationStrategy: {
          perPhase: plan?.phases.map((phase) => ({ phase: phase.id, commands: phase.validationCommands, criteria: phase.acceptanceCriteria })) ?? [],
          finalIntegratedChecks: unique(plan?.phases.flatMap((candidate) => candidate.validationCommands) ?? []),
          completionEvidence: "Each phase must record changed files, validation evidence, criteria evidence, assumptions, risks, and scope deviations before dependent phases proceed."
        },
        approvedConstraints: state.constraints?.effective.map((constraint) => ({ text: constraint.text, source: constraint.source })) ?? state.triage?.constraints.mustNot ?? [],
        approvedOverrides: state.constraints?.userOverrides ?? [],
        execution: {
          provider: "auto",
          resolvedProvider: "resolved at coordinator dispatch",
          mode: "coordinator-managed",
          workspace: "isolated Git worktree outside the main checkout",
          workspaceRationale: "External worktrees avoid nested Git repositories, recursive search/build traversal, and main working-tree status pollution.",
          mainWorkingTree: "remains untouched",
          manualExecution: "not selected",
          implementationStarted: false
        },
        approval: {
          recommendation,
          recommendedLabel: recommendation.option === "approve-all-remaining" ? "Approve Workflow Plan and prepare Phase 1 brief" : "Approve Workflow Plan with phase-by-phase review",
          reason: recommendation.reasons.join(" "),
          permittedPolicies: state.mode === "rigorous" ? ["phase-by-phase"] : ["workflow-authorized", "phase-by-phase"]
        }
      }
    };
  }
  if (state.state === "executing" && phase) {
    const needsIntervention = ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status);
    const readiness = executingReadinessSummary(state);
    const brief = state.phaseBriefs?.[phase.id];
    const briefFailure = state.phaseBriefFailures?.[phase.id];
    const pendingDecision = state.approval?.pendingDecision;
    if (briefFailure) {
      const root = quoteArg(state.root);
      return {
        ...base,
        label: "Phase Execution Brief unavailable",
        userDecisionRequired: true,
        pendingDecision: `${phaseLabel(phase.id)} brief could not be completed.`,
        pendingAction: briefFailure.message,
        allowedIntents: ["retry", "revise", "view details", "cancel"],
        approvalActions: [
          { label: "Retry bounded inspection", intent: "retry", command: `leanrigor flow phase-brief ${state.id} ${phase.id} --refresh --root ${root}`, description: "Retry the same read-only inspection and deterministic quality gate within configured limits." },
          { label: "Revise Workflow Plan boundary", intent: "revise", command: `leanrigor flow revise-plan ${state.id} "<feedback>" --root ${root}`, description: "Correct the approved phase boundary before another brief is generated." },
          { label: "View diagnostics", intent: "view details", command: `leanrigor flow phase-brief-show ${state.id} ${phase.id} --root ${root}`, description: "Show unresolved inspection questions, exact quality diagnostics, limits, and provenance." },
          { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${root}`, description: "Cancel this workflow without starting execution." }
        ],
        summary: {
          phase: phase.id,
          objective: phase.objective,
          failure: briefFailure,
          executionAuthorized: false
        }
      };
    }
    const needsMaterialDriftReview = Boolean(brief)
      && pendingDecision?.type === "material-drift-review"
      && pendingDecision.status === "pending"
      && pendingDecision.phaseId === phase.id
      && pendingDecision.briefRevision === brief?.briefRevision;
    if (needsMaterialDriftReview) {
      const root = quoteArg(state.root);
      return {
        ...base,
        label: "Phase material drift review",
        userDecisionRequired: true,
        pendingDecision: pendingDecision.question,
        pendingAction: "Accept the still-trusted result with an auditable reason, rerun while preserving in-scope work, or revise the plan boundary.",
        allowedIntents: ["accept drift", "rerun", "revise plan", "revise brief", "view details", "cancel"],
        approvalActions: [
          ...(pendingDecision.allowedActions.includes("accept-drift") ? [{ label: "Accept trusted drift", intent: "accept drift", command: `leanrigor flow accept-drift ${state.id} --decision-id ${pendingDecision.id} --expected-revision ${state.revision} --reason <reason> --provider auto --json --root ${root}`, description: "Record why this exact trusted result is acceptable, then replay it through normal completion and integration gates." }] : []),
          ...(pendingDecision.allowedActions.includes("rerun-drift") ? [{ label: "Rerun with preserved worktree", intent: "rerun", command: `leanrigor flow rerun-drift ${state.id} --decision-id ${pendingDecision.id} --expected-revision ${state.revision} --provider auto --json --root ${root}`, description: "Start a fresh provider attempt without discarding approved-scope work." }] : []),
          { label: "Revise Workflow Plan", intent: "revise plan", command: `leanrigor flow revise-plan ${state.id} --feedback-file <feedback-file> --provider auto --root ${root}`, description: "Record the material change in a fresh Workflow Plan and return it for approval." },
          { label: `Revise ${phaseLabel(phase.id)} brief`, intent: "revise brief", command: `leanrigor flow phase-brief ${state.id} ${phase.id} --feedback-file <feedback-file> --root ${root}`, description: "Create a new brief revision that remains within the currently approved plan." },
          { label: "View full details", intent: "view details", command: `leanrigor flow phase-brief-show ${state.id} ${phase.id} --root ${root}`, description: "Show the persisted material changes, inspection evidence, risks, and exact brief revision." },
          { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${root}`, description: "Cancel without approving or executing the material brief." }
        ],
        summary: {
          phase: phase.id,
          objective: brief?.objective,
          briefRevision: brief?.briefRevision,
          workflowRevision: brief?.workflowRevision,
          risks: brief?.risks ?? [],
          riskDiscoveries: brief?.riskDiscoveries ?? [],
          changesFromApprovedWorkflowPlan: brief?.materialChangesFromWorkflowPlan ?? [],
          withinApprovedPlan: false,
          executionAuthorized: false,
          pendingDecision
        }
      };
    }
    const needsPhaseApproval = Boolean(brief)
      && pendingDecision?.type === "phase-brief-approval"
      && pendingDecision.status === "pending"
      && pendingDecision.phaseId === phase.id
      && pendingDecision.briefRevision === brief?.briefRevision
      && pendingDecision.workflowRevision === brief?.workflowRevision;
    if (needsPhaseApproval) {
      const root = quoteArg(state.root);
      const recommendation = state.approval?.recommendation ?? approvalRecommendation(state, phase.id);
      return {
        ...base,
        label: "Phase execution brief",
        userDecisionRequired: true,
        pendingDecision: `Approve ${phaseLabel(phase.id)} using Workflow Plan revision ${pendingDecision?.workflowRevision} and execution brief revision ${pendingDecision?.briefRevision}.`,
        pendingAction: "Review the phase brief and select an action.",
        allowedIntents: ["approve", "revise", "view details", "cancel"],
        approvalActions: [
          { label: `Approve ${phaseLabel(phase.id)}`, intent: "approve", command: `leanrigor flow approve-phase ${state.id} ${phase.id} --brief-revision ${brief?.briefRevision ?? 0} --workflow-revision ${pendingDecision?.workflowRevision ?? 0} --root ${root}`, description: "Authorize exactly this persisted Workflow Plan and detailed Phase Execution Brief revision." },
          { label: `Revise ${phaseLabel(phase.id)} brief`, intent: "revise", command: `leanrigor flow phase-brief ${state.id} ${phase.id} --feedback-file <feedback-file> --root ${root}`, description: "Persist feedback, rerun bounded planning, and create a new unapproved brief revision." },
          { label: "View full details", intent: "view details", command: `leanrigor flow phase-brief-show ${state.id} ${phase.id} --root ${root}`, description: "Show the persisted objective, files, symbols, obligations, validation, risks, material changes, and inspection provenance." },
          { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${root}`, description: "Cancel this workflow." }
        ],
        summary: {
          title: `${phaseLabel(phase.id)} Execution Brief`,
          phase: phase.id,
          objective: brief?.objective,
          concreteDeliverable: brief?.deliverable,
          currentBehaviour: brief?.currentBehaviour,
          implementationApproach: brief?.implementationApproach,
          affectedFilesAndSymbols: {
            read: brief?.readAreas ?? [],
            write: brief?.writeAreas ?? [],
            relevantFiles: brief?.relevantFiles ?? [],
            relevantSymbols: brief?.relevantSymbols ?? []
          },
          acceptanceCriteria: brief?.acceptanceCriteria ?? [],
          testObligations: brief?.testObligations ?? [],
          validationCommands: brief?.validationCommands ?? [],
          dependencies: brief?.dependencies ?? [],
          assumptions: brief?.assumptions ?? [],
          exclusions: brief?.exclusions ?? [],
          risks: brief?.risks ?? [],
          changesFromApprovedWorkflowPlan: brief?.materialChangesFromWorkflowPlan ?? [],
          inspectionProvenance: brief ? {
            status: brief.inspectionResult.status,
            repositoryRevision: brief.repository.repositoryRevision,
            inspectedPaths: brief.repository.inspectedPaths,
            scopeExpansions: brief.inspectionRequest.scopeExpansions,
            source: brief.inspectionResult.provenance.source,
            provider: brief.generation.provider,
            modelTier: brief.generation.modelTier,
            reads: brief.inspectionResult.filesRead.length,
            bytes: brief.inspectionResult.bytesRead
          } : undefined,
          validation: brief?.validation,
          briefRevision: brief?.briefRevision,
          pendingDecision,
          recommendation,
          withinApprovedPlan: !brief?.materialChangesFromWorkflowPlan.some((change) => change.material)
        }
      };
    }
    if (pendingDecision?.type === "workspace-bootstrap-approval" && pendingDecision.status === "pending" && pendingDecision.phaseId === phase.id) {
      const root = quoteArg(state.root);
      return {
        ...base,
        label: "Workspace preparation approval",
        userDecisionRequired: true,
        pendingDecision: pendingDecision.question,
        pendingAction: `Review the exact command and risks for preparation revision ${pendingDecision.preparationRevision}. No provider has been dispatched.`,
        allowedIntents: ["approve bootstrap", "retry", "view details", "cancel"],
        approvalActions: [
          {
            label: "Approve bootstrap",
            intent: "approve bootstrap",
            command: `leanrigor flow approve-bootstrap ${state.id} ${phase.id} --brief-revision ${pendingDecision.briefRevision} --preparation-revision ${pendingDecision.preparationRevision} --workspace-identity ${quoteArg(pendingDecision.workspaceIdentity)} --command ${quoteArg(pendingDecision.command)} --root ${root}`,
            description: "Approve only this command for this brief, workspace, and preparation revision."
          },
          { label: "Retry preparation", intent: "retry", command: `leanrigor flow execute-next ${state.id} --provider auto --root ${root}`, description: "Rerun deterministic preparation without authorising a different command." },
          { label: "View full details", intent: "view details", command: `leanrigor flow status ${state.id} --root ${root}`, description: "Show preparation evidence, command risk, and exact identities." },
          { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root ${root}`, description: "Cancel without dispatching a provider." }
        ],
        summary: {
          phase: phase.id,
          dependencyReady: true,
          dispatchReady: false,
          blocker: "workspace_bootstrap_pending",
          briefRevision: pendingDecision.briefRevision,
          preparationRevision: pendingDecision.preparationRevision,
          workspaceIdentity: pendingDecision.workspaceIdentity,
          command: pendingDecision.command,
          riskSummary: pendingDecision.riskSummary,
          providerDispatched: false
        }
      };
    }
    return {
      ...base,
      label: needsIntervention ? "Phase recovery decision" : "Phase execution status",
      userDecisionRequired: needsIntervention,
      pendingDecision: needsIntervention ? phase.completion?.reason ?? "The active phase needs intervention." : null,
      pendingAction: phase.status === "ready" && readiness.recommendedNextPhase
        ? `Execute recommended next phase ${readiness.recommendedNextPhase.id}. Other dependency-ready phases require explicit selection.`
        : phaseNextAction(phase.status),
      allowedIntents: phaseIntents(phase.status),
      approvalActions: needsIntervention ? phaseApprovalActions(state, phase) : undefined,
      summary: {
        phase: phase.id,
        objective: phase.objective,
        status: phase.status,
        completionGate: phase.completion?.decision ?? "pending",
        criteria: phase.completion ? summariseCriteria(phase.completion.criteria) : undefined,
        validation: phase.completion?.validation.status ?? "pending",
        repairAttempts: phase.repairAttempts.length,
        scopeDeviations: phase.scopeDeviations,
        recommendedNextPhase: readiness.recommendedNextPhase,
        otherDependencyReadyPhases: readiness.otherDependencyReadyPhases,
        planOrderPrimary: state.mode === "standard" || state.mode === "rigorous",
        phaseBrief: brief,
        approval: state.approval
      }
    };
  }
  if (state.state === "validating" || state.state === "reviewing") {
    return {
      ...base,
      label: "Final integrated review",
      userDecisionRequired: false,
      pendingDecision: null,
      pendingAction: "Run the final integrated review and record the result.",
      allowedIntents: ["continue", "show status", "cancel"],
      summary: {
        validation: state.validation.map((evidence) => ({ command: evidence.command, status: evidence.status, result: evidence.result })),
        review: state.review,
        acceptedMaterialDrifts: (state.plan?.phases ?? []).flatMap((phase) => (phase.acceptedDrifts ?? []).map((drift) => ({ phaseId: phase.id, ...drift })))
      }
    };
  }
  if (state.state === "awaiting_commit_approval") {
    const commands = nextActions(state);
    return {
      ...base,
      label: "Commit proposal",
      userDecisionRequired: true,
      pendingDecision: "Review the commit proposal. No commit or push has occurred.",
      pendingAction: "Select an action: review the proposal, complete the workflow, or cancel.",
      allowedIntents: ["show proposal", "complete", "cancel", "show status"],
      approvalActions: [
        { label: "Complete", intent: "complete", command: commands[1] ?? "", description: "Finalize the workflow. No commit or push is performed." },
        { label: "Show Proposal", intent: "show proposal", command: commands[0] ?? "", description: "Display the commit proposal for review." },
        { label: "Cancel", intent: "cancel", command: `leanrigor flow cancel ${state.id} --root "${state.root}"`, description: "Cancel this workflow." }
      ],
      summary: { commitPlan: commitPlanSummary(state.commitPlan) }
    };
  }
  if (state.state === "blocked") {
    const planBlocked = Boolean(state.planningRun?.approvalBlockedReason);
    if (planBlocked) {
      const root = quoteArg(state.root);
      const decision = state.approval?.pendingDecision;
      const common = decision?.status === "pending"
        ? ` --decision-id ${quoteArg(decision.id)} --expected-revision ${state.revision}`
        : "";
      return {
        ...base,
        label: "Planning fallback review",
        userDecisionRequired: true,
        pendingDecision: state.planningRun?.approvalBlockedReason ?? "The generated fallback plan is not safe to approve as-is.",
        pendingAction: "Retry structured planning, revise the plan with feedback, inspect the persisted diagnostics, or cancel.",
        allowedIntents: ["retry", "revise", "view details", "show status", "cancel"],
        approvalActions: [
          { label: "Retry structured planning", intent: "retry", command: `leanrigor flow retry-plan ${state.id} --provider auto${common} --root ${root}`, description: "Retry bounded structured planning using the configured provider." },
          { label: "Revise Workflow Plan", intent: "revise", command: `leanrigor flow revise-plan ${state.id} --feedback-file <feedback-file> --provider auto${common} --root ${root}`, description: "Provide concrete feedback and generate a fresh plan for approval." },
          { label: "View planning details", intent: "view details", command: `leanrigor flow status ${state.id} --json --root ${root}`, description: "Show the exact invocation, validation, repair, and fallback evidence." },
          { label: "Cancel workflow", intent: "cancel", command: `leanrigor flow cancel ${state.id}${common} --root ${root}`, description: "Cancel without implementation, commit, or push." }
        ],
        summary: {
          approvalSafe: false,
          explanation: planningOutcomeExplanation(state),
          source: state.planningRun?.source,
          provider: state.planningRun?.provider,
          model: state.planningRun?.model,
          attempts: state.planningRun?.attemptRecords ?? [],
          warnings: state.planningRun?.warnings ?? [],
          diagnostics: state.planningRun?.diagnostics ?? [],
          fallbackReason: state.planningRun?.fallbackReason,
          blockers: state.blockers
        }
      };
    }
    return {
      ...base,
      label: "Blocked",
      userDecisionRequired: true,
      pendingDecision: state.blockers[0] ?? "Workflow is blocked.",
      pendingAction: "Resolve the blocker, revise the workflow, or cancel.",
      allowedIntents: ["show status", "cancel"],
      summary: { blockers: state.blockers }
    };
  }
  return {
    ...base,
    label: "Workflow status",
    userDecisionRequired: false,
    pendingDecision: null,
    pendingAction: "Inspect the workflow state.",
    allowedIntents: ["show status", "cancel"],
    summary: {}
  };
}

export function currentPhaseObject(state: SequentialWorkflowState): WorkflowPhase | undefined {
  return state.plan?.phases.find((phase) => phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending")
    ?? state.plan?.phases.find((phase) => phase.status === "ready")
    ?? state.plan?.phases.find((phase) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status))
    ?? state.plan?.phases.find((phase) => Boolean(state.phaseBriefFailures?.[phase.id]))
    ?? state.plan?.phases.find((phase) => phase.id === state.approval?.pendingDecision?.phaseId);
}

function executingReadinessSummary(state: SequentialWorkflowState): {
  recommendedNextPhase?: { id: string; objective: string };
  otherDependencyReadyPhases: Array<{ id: string; objective: string }>;
} {
  const phases = state.plan?.phases ?? [];
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const dependencyReady = phases.filter((phase) =>
    ["planned", "ready"].includes(phase.status)
    && phase.dependencies.every((dependency) => byId.get(dependency)?.status === "completed"));
  const recommended = dependencyReady[0];
  return {
    recommendedNextPhase: recommended ? { id: recommended.id, objective: recommended.objective } : undefined,
    otherDependencyReadyPhases: dependencyReady.slice(1).map((phase) => ({ id: phase.id, objective: phase.objective }))
  };
}

function phaseLabel(phaseId: string): string {
  const match = phaseId.match(/^phase-(\d+)$/i);
  return match ? `Phase ${match[1]}` : phaseId;
}

function planExecutionStructure(state: SequentialWorkflowState): {
  planType: "sequential" | "parallel-candidates";
  dependencies: Array<{ phase: string; dependsOn: string[] }>;
  independentPhases: string[];
  outOfOrderExecution: string;
  recommendedNextPhase?: { id: string; objective: string };
} {
  const phases = state.plan?.phases ?? [];
  const independent = phases.filter((phase) => phase.dependencies.length === 0).map((phase) => phase.id);
  const recommended = phases.find((phase) => phase.dependencies.length === 0);
  return {
    planType: independent.length > 1 ? "parallel-candidates" : "sequential",
    dependencies: phases.map((phase) => ({ phase: phase.id, dependsOn: phase.dependencies })),
    independentPhases: independent,
    outOfOrderExecution: independent.length > 1 ? "Possible only for dependency-ready phases without write conflicts and with explicit execution selection." : "Not applicable; follow dependency order.",
    recommendedNextPhase: recommended ? { id: recommended.id, objective: recommended.objective } : undefined
  };
}

function architectureBoundaryForArea(area: string): string {
  const normalised = area.replace(/\\/g, "/").toLowerCase();
  if (normalised.startsWith("src/core/")) return "src/core";
  if (normalised.startsWith("src/cli/")) return "src/cli";
  if (normalised.startsWith("src/config/")) return "src/config";
  if (normalised.startsWith("src/adapters/")) return normalised.split("/").slice(0, 3).join("/");
  if (normalised.startsWith("tests/")) return "tests";
  if (/^(docs|readme\.md|commands|methodology)\b/.test(normalised)) return "docs";
  return area;
}

export function phaseRepairBudget(state: SequentialWorkflowState): number {
  if (state.mode === "fast") return 1;
  return 2;
}

function workflowListSummary(state: SequentialWorkflowState): WorkflowListSummary {
  return {
    id: state.id,
    request: state.request,
    state: state.state,
    mode: state.mode,
    updatedAt: state.updatedAt
  };
}

function phaseNextAction(status: string): string {
  if (status === "needs_repair") return "Repair the phase within the gate's requested scope; continue cannot bypass repair.";
  if (status === "needs_review") return "Review the uncertain phase evidence or revise the plan.";
  if (status === "needs_replan") return "Revise the plan before continuing.";
  if (status === "blocked") return "Resolve the blocker or cancel.";
  if (status === "ready") return "Execute the ready phase after acquiring the internal phase lease, record validation, and submit completion evidence.";
  return "Execute the leased phase, record validation, and submit completion evidence.";
}

function phaseIntents(status: string): string[] {
  if (status === "needs_repair") return ["repair it", "revise", "show status", "cancel"];
  if (status === "needs_review") return ["review", "revise", "show status", "cancel"];
  if (status === "needs_replan") return ["revise", "show status", "cancel"];
  if (status === "blocked") return ["show status", "cancel"];
  return ["continue", "show status", "show plan", "cancel"];
}

function phaseApprovalActions(state: SequentialWorkflowState, phase: WorkflowPhase): ApprovalAction[] {
  const reason = phase.completion?.reason ?? "Phase completion gate requires intervention.";
  const root = quoteArg(state.root);
  const actions: ApprovalAction[] = [];
  if (phase.status === "needs_repair") {
    actions.push({
      label: "Repair",
      intent: "repair it",
      command: `leanrigor flow repair ${state.id} ${phase.id} --reason ${quoteArg(reason)} --root ${root}`,
      description: "Start a bounded repair for the completion-gate issue."
    });
    actions.push({
      label: "Revise Plan",
      intent: "revise",
      command: `leanrigor flow revise-plan ${state.id} "<feedback>" --root ${root}`,
      description: "Request a plan revision instead of another repair attempt."
    });
  } else if (phase.status === "needs_review") {
    actions.push({
      label: "Review",
      intent: "review",
      command: `leanrigor flow phase-status ${state.id} ${phase.id} --root ${root}`,
      description: "Inspect the uncertain phase evidence and decide whether repair or replanning is required."
    });
    actions.push({
      label: "Revise Plan",
      intent: "revise",
      command: `leanrigor flow revise-plan ${state.id} "<feedback>" --root ${root}`,
      description: "Revise the persisted plan before more execution."
    });
  } else if (phase.status === "needs_replan") {
    actions.push({
      label: "Revise Plan",
      intent: "revise",
      command: `leanrigor flow revise-plan ${state.id} "<feedback>" --root ${root}`,
      description: "Revise the persisted plan before continuing."
    });
  } else if (phase.status === "blocked") {
    actions.push({
      label: "Show Status",
      intent: "show status",
      command: `leanrigor flow status ${state.id} --root ${root}`,
      description: "Show the persisted blocker and current workflow state."
    });
  }
  actions.push({
    label: "Cancel",
    intent: "cancel",
    command: `leanrigor flow cancel ${state.id} --root ${root}`,
    description: "Cancel this workflow."
  });
  return actions;
}

function internalOperationsFor(state: SequentialWorkflowState): string[] {
  if (state.state === "awaiting_clarification") return ["answer"];
  if (state.state === "awaiting_approach_approval") return ["approve-approach", "revise-approach", "status", "cancel"];
  if (state.state === "awaiting_plan_approval") return ["approve-plan", "revise-plan", "cancel"];
  if (state.state === "executing") return ["execute-next", "execution-status", "execution-poll", "ready", "repair", "recover-leases", "revise-plan", "cancel"];
  if (state.state === "validating" || state.state === "reviewing") return ["record-validation", "record-review"];
  if (state.state === "blocked" && state.planningRun?.approvalBlockedReason) return ["retry-plan", "revise-plan", "status", "cancel"];
  if (state.state === "awaiting_commit_approval") return ["commit-plan", "complete", "cancel"];
  return ["status"];
}

function planningOutcomeExplanation(state: SequentialWorkflowState): string {
  const planning = state.planningRun;
  if (!planning) return "Planning provenance is unavailable.";
  const records = planning.attemptRecords ?? [];
  const draft = records.find((record) => record.stage === "draft");
  if (draft?.invocation === "failed" && draft.validation === "not-attempted") {
    return "The planning provider failed before returning a candidate plan. Candidate validation and semantic repair were not attempted.";
  }
  if (draft?.invocation === "succeeded" && draft.validation === "failed") {
    const repaired = records.some((record) => (record.stage === "repair" || record.stage === "escalation") && record.validation === "passed");
    return repaired
      ? "The provider returned a candidate that failed deterministic validation; a later bounded repair produced the persisted approval-quality plan."
      : "The provider returned a candidate that failed deterministic validation, and no later repair produced an approval-quality plan.";
  }
  if (draft?.validation === "passed") return "The provider returned a candidate plan that passed deterministic validation.";
  if (planning.source === "deterministic-fallback") return `Deterministic fallback was applied${planning.fallbackReason ? `: ${planning.fallbackReason}` : "."}`;
  return "The persisted planning attempt evidence does not include a complete draft outcome.";
}

function commitPlanSummary(plan: CommitPlan | undefined): unknown {
  return plan ? {
    generatedAt: plan.generatedAt,
    note: plan.note,
    groups: plan.groups.map((group) => ({ message: group.message, files: group.files, rationale: group.rationale }))
  } : undefined;
}

function summariseCriteria(criteria: Array<{ status: string }>): { met: number; notMet: number; uncertain: number; notApplicable: number } {
  return {
    met: criteria.filter((criterion) => criterion.status === "met").length,
    notMet: criteria.filter((criterion) => criterion.status === "not_met").length,
    uncertain: criteria.filter((criterion) => criterion.status === "uncertain").length,
    notApplicable: criteria.filter((criterion) => criterion.status === "not_applicable").length
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function quoteArg(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}
