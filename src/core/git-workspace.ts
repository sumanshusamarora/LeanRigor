import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, constants, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeanRigorConfig } from "../config/schema.js";
import { dependencyIds } from "./scheduler.js";
import type {
  IntegrationValidation,
  PhaseGitEvidence,
  PhaseWorkspace,
  SequentialWorkflowState,
  ValidationEvidence,
  WorkflowGitContext,
  WorkflowGitState,
  WorkflowPhase
} from "./types.js";

const execFileAsync = promisify(execFile);
const OWNERSHIP_VERSION = 1;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface GitPreflightResult {
  ok: boolean;
  code?: string;
  operation?: string;
  repositoryRoot?: string;
  gitCommonDir?: string;
  baseCommit?: string;
  originalHead?: string;
  originalBranch?: string;
  workspaceRoot?: string;
  warnings?: string[];
  message?: string;
}

export interface IntegrationOperationResult {
  ok: boolean;
  code: "integrated" | "already_integrated" | "integration_conflict" | "integration_rejected";
  phaseId: string;
  integrationHead?: string;
  conflictingFiles?: string[];
  nextAction?: string;
  state: SequentialWorkflowState;
}

export interface WorkspaceStatus {
  workflowId: string;
  git?: WorkflowGitState;
  preflight: GitPreflightResult;
  phaseWorkspaces: PhaseWorkspace[];
}

export interface WorkspaceCleanupReport {
  workflowId: string;
  mode: "safe" | "force-owned" | "archive";
  removedWorktrees: string[];
  retainedWorktrees: Array<{ path: string; reason: string }>;
  removedBranches: string[];
  needsReview: string[];
}

export interface WorkspaceRecoveryReport {
  workflowId: string;
  facts: string[];
  needsReview: string[];
  state: SequentialWorkflowState;
}

export class GitWorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

interface OwnershipMetadata {
  version: 1;
  generatedBy: "leanrigor";
  workflowId: string;
  workspaceType: "integration" | "phase";
  phaseId?: string;
  path: string;
  branch: string;
  repositoryRoot: string;
  createdAt: string;
}

interface GitStatusEntry {
  index: string;
  workingTree: string;
  path: string;
  originalPath?: string;
}

export async function preflightGitRepository(root: string, config: LeanRigorConfig): Promise<GitPreflightResult> {
  const warnings: string[] = [];
  let repositoryRoot: string;
  try {
    repositoryRoot = await canonical((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return { ok: false, code: "not_git_worktree", message: "Path is not inside a Git worktree." };
  }

  const bare = (await git(repositoryRoot, ["rev-parse", "--is-bare-repository"]).catch(() => "true")).trim();
  if (bare === "true") return { ok: false, code: "bare_repository", repositoryRoot };

  const versionText = (await git(repositoryRoot, ["--version"]).catch(() => "")).trim();
  if (!gitVersionSupportsWorktree(versionText)) {
    return { ok: false, code: "unsupported_git_version", repositoryRoot, message: versionText };
  }

  const gitCommonDir = await resolveGitPath(repositoryRoot, (await git(repositoryRoot, ["rev-parse", "--git-common-dir"])).trim());
  const gitDir = await resolveGitPath(repositoryRoot, (await git(repositoryRoot, ["rev-parse", "--git-dir"])).trim());
  const operation = await gitOperationInProgress(gitCommonDir, gitDir);
  if (operation) return { ok: false, code: "git_operation_in_progress", operation, repositoryRoot, gitCommonDir };

  let originalHead: string;
  try {
    originalHead = (await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    return { ok: false, code: "missing_head", repositoryRoot, gitCommonDir };
  }
  const originalBranch = (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || undefined;
  const worktreeMetadataReadable = await git(repositoryRoot, ["worktree", "list", "--porcelain"]).then(() => true).catch(() => false);
  if (!worktreeMetadataReadable) return { ok: false, code: "worktree_metadata_unreadable", repositoryRoot, gitCommonDir };

  const nested = await findNestedRepositories(repositoryRoot);
  if (nested.length > 0) {
    return { ok: false, code: "nested_repository_ambiguous", repositoryRoot, gitCommonDir, message: nested.join(", ") };
  }

  const workspaceRoot = resolveWorkspaceRoot(repositoryRoot, config);
  if (isPathInside(workspaceRoot, repositoryRoot) && !isPathInside(workspaceRoot, gitCommonDir)) {
    return { ok: false, code: "dangerous_workspace_root", repositoryRoot, gitCommonDir, workspaceRoot };
  }
  if (workspaceRoot.length > config.execution.maxWorkspacePathLength) {
    return { ok: false, code: "workspace_path_too_long", repositoryRoot, gitCommonDir, workspaceRoot };
  }
  const writable = await mkdir(workspaceRoot, { recursive: true })
    .then(() => access(workspaceRoot, constants.W_OK))
    .then(() => true)
    .catch(() => false);
  if (!writable) return { ok: false, code: "workspace_root_not_writable", repositoryRoot, gitCommonDir, workspaceRoot };

  const dirty = (await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
  if (dirty) warnings.push("User working tree has local changes outside the LeanRigor workflow baseline.");

  return {
    ok: true,
    repositoryRoot,
    gitCommonDir,
    baseCommit: originalHead,
    originalHead,
    originalBranch,
    workspaceRoot,
    warnings
  };
}

export async function ensureIntegrationWorkspace(state: SequentialWorkflowState, config: LeanRigorConfig): Promise<WorkflowGitState> {
  if (config.execution.workspaceStrategy === "none") {
    throw new GitWorkspaceError("workspace_strategy_disabled", "Git worktree workspaces are disabled by configuration.");
  }
  const preflight = await requirePreflight(state.root, config);
  const existing = state.git;
  if (existing && await ownedWorktreeExists(existing.integration.path, state.id, "integration")) return existing;

  const names = workspaceNames(state.id, undefined, config);
  const workflowRoot = path.join(preflight.workspaceRoot!, state.id);
  const integrationPath = path.join(workflowRoot, "integration");
  ensurePathLength(integrationPath, config);
  await ensurePathAvailable(integrationPath, state.id, "integration");

  const integrationBranch = existing?.context.integrationBranch ?? names.integrationBranch;
  const integrationBranchExists = await ensureBranchAvailable(preflight.repositoryRoot!, integrationBranch, existing?.context.integrationBranch === integrationBranch);
  await mkdir(path.dirname(integrationPath), { recursive: true });
  await addWorktree(preflight.repositoryRoot!, integrationPath, integrationBranch, integrationBranchExists ? integrationBranch : preflight.baseCommit!, !integrationBranchExists);

  const headCommit = (await git(integrationPath, ["rev-parse", "HEAD"])).trim();
  const now = timestamp();
  await writeOwnershipMetadata(workflowRoot, {
    version: OWNERSHIP_VERSION,
    generatedBy: "leanrigor",
    workflowId: state.id,
    workspaceType: "integration",
    path: integrationPath,
    branch: integrationBranch,
    repositoryRoot: preflight.repositoryRoot!,
    createdAt: now
  });

  const context: WorkflowGitContext = existing?.context ?? {
    repositoryRoot: preflight.repositoryRoot!,
    gitCommonDir: preflight.gitCommonDir!,
    baseCommit: preflight.baseCommit!,
    originalHead: preflight.originalHead!,
    originalBranch: preflight.originalBranch,
    createdAt: now,
    integrationBranch,
    integrationWorktreePath: integrationPath,
    workspaceRoot: preflight.workspaceRoot!,
    branchPrefix: config.execution.workspaceBranchPrefix,
    transferStrategy: "internal-commit"
  };

  return {
    context,
    integration: {
      path: integrationPath,
      branch: integrationBranch,
      baseCommit: context.baseCommit,
      headCommit,
      status: "ready",
      integratedPhaseIds: existing?.integration.integratedPhaseIds ?? [],
      conflictingPhaseIds: existing?.integration.conflictingPhaseIds ?? [],
      conflictedFiles: existing?.integration.conflictedFiles ?? []
    },
    phaseWorkspaces: existing?.phaseWorkspaces ?? {},
    integrationValidation: existing?.integrationValidation
  };
}

export async function createPhaseWorkspace(state: SequentialWorkflowState, phaseId: string, ownerId: string, config: LeanRigorConfig): Promise<WorkflowGitState> {
  if (!state.plan) throw new GitWorkspaceError("missing_plan", "Cannot create a phase workspace without an approved plan.");
  const gitState = state.git ?? await ensureIntegrationWorkspace(state, config);
  const phase = state.plan.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new GitWorkspaceError("unknown_phase", `Unknown phase: ${phaseId}`);
  const lease = state.phaseLeases[phaseId];
  if (!lease || lease.releasedAt || lease.ownerId !== ownerId || Date.parse(lease.expiresAt) <= Date.now()) {
    throw new GitWorkspaceError("phase_workspace_requires_lease", `Phase ${phaseId} workspace requires an active lease held by ${ownerId}.`);
  }
  if (!["leased", "running"].includes(phase.status)) {
    throw new GitWorkspaceError("phase_not_leased", `Phase ${phaseId} is ${phase.status}; only a leased phase can create a workspace.`);
  }
  const existing = gitState.phaseWorkspaces[phaseId];
  if (existing && await ownedWorktreeExists(existing.path, state.id, "phase", phaseId)) return gitState;

  const missingDependencies = dependencyIds(phase).filter((dependency) => !gitState.integration.integratedPhaseIds.includes(dependency));
  if (missingDependencies.length > 0) {
    throw new GitWorkspaceError("phase_dependencies_not_integrated", `Phase ${phaseId} dependencies are not integrated: ${missingDependencies.join(", ")}`, { missingDependencies });
  }

  const names = workspaceNames(state.id, phaseId, config);
  const workflowRoot = path.join(gitState.context.workspaceRoot, state.id);
  const phasePath = path.join(workflowRoot, "phases", names.phasePathSegment!);
  ensurePathLength(phasePath, config);
  await ensurePathAvailable(phasePath, state.id, "phase", phaseId);
  const phaseBranchExists = await ensureBranchAvailable(gitState.context.repositoryRoot, names.phaseBranch!, existing?.branch === names.phaseBranch);
  await mkdir(path.dirname(phasePath), { recursive: true });
  await addWorktree(gitState.context.repositoryRoot, phasePath, names.phaseBranch!, phaseBranchExists ? names.phaseBranch! : gitState.integration.headCommit, !phaseBranchExists);

  const now = timestamp();
  await writeOwnershipMetadata(workflowRoot, {
    version: OWNERSHIP_VERSION,
    generatedBy: "leanrigor",
    workflowId: state.id,
    workspaceType: "phase",
    phaseId,
    path: phasePath,
    branch: names.phaseBranch!,
    repositoryRoot: gitState.context.repositoryRoot,
    createdAt: now
  });

  const workspace: PhaseWorkspace = {
    phaseId,
    leaseOwnerId: ownerId,
    path: phasePath,
    branch: names.phaseBranch!,
    baseCommit: gitState.integration.headCommit,
    createdAt: now,
    updatedAt: now,
    status: "active"
  };
  return {
    ...gitState,
    phaseWorkspaces: { ...gitState.phaseWorkspaces, [phaseId]: workspace }
  };
}

export async function captureApprovedPhaseChange(state: SequentialWorkflowState, phase: WorkflowPhase, ownerId: string, config: LeanRigorConfig): Promise<PhaseGitEvidence | undefined> {
  if (!state.git) return undefined;
  const workspace = state.git.phaseWorkspaces[phase.id];
  if (!workspace) throw new GitWorkspaceError("phase_workspace_missing", `Phase ${phase.id} has no isolated workspace.`);
  if (workspace.leaseOwnerId !== ownerId) {
    throw new GitWorkspaceError("phase_workspace_owner_mismatch", `Phase workspace is owned by ${workspace.leaseOwnerId}, not ${ownerId}.`);
  }
  if (!await ownedWorktreeExists(workspace.path, state.id, "phase", phase.id)) {
    throw new GitWorkspaceError("phase_workspace_unowned", `Phase workspace ownership metadata is missing or invalid: ${workspace.path}`);
  }
  const branch = (await git(workspace.path, ["branch", "--show-current"])).trim();
  if (branch !== workspace.branch) throw new GitWorkspaceError("phase_workspace_branch_mismatch", `Phase workspace is on ${branch}, expected ${workspace.branch}.`);
  const currentHead = (await git(workspace.path, ["rev-parse", "HEAD"])).trim();
  const gitDir = await resolveGitPath(workspace.path, (await git(workspace.path, ["rev-parse", "--git-dir"])).trim());
  const commonDir = await resolveGitPath(workspace.path, (await git(workspace.path, ["rev-parse", "--git-common-dir"])).trim());
  const operation = await gitOperationInProgress(commonDir, gitDir);
  if (operation) throw new GitWorkspaceError("git_operation_in_progress", `Phase workspace has an active Git operation: ${operation}`, { operation });

  const statusEntries = parsePorcelain(await git(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const untrackedFiles = statusEntries.filter((entry) => entry.index === "?" || entry.workingTree === "?").map((entry) => entry.path).sort();

  await git(workspace.path, ["add", "-A", "--", "."]);
  const changedFiles = splitNul(await git(workspace.path, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTD"])).sort();
  await rejectUnsafeSymlinks(workspace.path, changedFiles);
  const diff = await git(workspace.path, ["diff", "--cached", "--binary", "--full-index"], { maxBuffer: MAX_GIT_OUTPUT });
  const diffHash = createHash("sha256").update(workspace.baseCommit).update("\0").update(diff).digest("hex");
  const binaryFiles = parseBinaryFiles(await git(workspace.path, ["diff", "--cached", "--numstat", "-z"]));
  const fileModeChanges = parseModeChanges(await git(workspace.path, ["diff", "--cached", "--summary"]));

  if (changedFiles.length === 0) {
    return {
      workspacePath: workspace.path,
      baseCommit: workspace.baseCommit,
      workspaceHead: currentHead,
      changedFiles: [],
      diffHash,
      untrackedFiles: [],
      transferStrategy: "internal-commit",
      binaryFiles: [],
      fileModeChanges: []
    };
  }

  const commitArgs = [
    "-c", "user.name=LeanRigor",
    "-c", "user.email=leanrigor@local",
    ...(config.execution.internalCommitSigning === "disabled" ? ["-c", "commit.gpgsign=false"] : []),
    "commit",
    "-m", `leanrigor: internal phase ${phase.id}`,
    "-m", `Workflow: ${state.id}`,
    "-m", "Internal transfer commit only; not the final user commit."
  ];
  await git(workspace.path, commitArgs, { maxBuffer: MAX_GIT_OUTPUT });
  const workspaceHead = (await git(workspace.path, ["rev-parse", "HEAD"])).trim();
  return {
    workspacePath: workspace.path,
    baseCommit: workspace.baseCommit,
    workspaceHead,
    changedFiles,
    diffHash,
    untrackedFiles,
    validationCommitOrPatch: workspaceHead,
    transferStrategy: "internal-commit",
    binaryFiles,
    fileModeChanges
  };
}

export async function inspectPhaseWorkspaceChanges(state: SequentialWorkflowState, phase: WorkflowPhase, ownerId: string): Promise<Pick<PhaseGitEvidence, "changedFiles" | "diffHash" | "untrackedFiles" | "binaryFiles" | "fileModeChanges"> | undefined> {
  if (!state.git) return undefined;
  const workspace = state.git.phaseWorkspaces[phase.id];
  if (!workspace) throw new GitWorkspaceError("phase_workspace_missing", `Phase ${phase.id} has no isolated workspace.`);
  if (workspace.leaseOwnerId !== ownerId) {
    throw new GitWorkspaceError("phase_workspace_owner_mismatch", `Phase workspace is owned by ${workspace.leaseOwnerId}, not ${ownerId}.`);
  }
  const statusEntries = parsePorcelain(await git(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const untrackedFiles = statusEntries.filter((entry) => entry.index === "?" || entry.workingTree === "?").map((entry) => entry.path).sort();
  await git(workspace.path, ["add", "-A", "--", "."]);
  try {
    const changedFiles = splitNul(await git(workspace.path, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTD"])).sort();
    await rejectUnsafeSymlinks(workspace.path, changedFiles);
    const diff = await git(workspace.path, ["diff", "--cached", "--binary", "--full-index"], { maxBuffer: MAX_GIT_OUTPUT });
    return {
      changedFiles,
      diffHash: createHash("sha256").update(workspace.baseCommit).update("\0").update(diff).digest("hex"),
      untrackedFiles,
      binaryFiles: parseBinaryFiles(await git(workspace.path, ["diff", "--cached", "--numstat", "-z"])),
      fileModeChanges: parseModeChanges(await git(workspace.path, ["diff", "--cached", "--summary"]))
    };
  } finally {
    await git(workspace.path, ["reset", "-q", "--mixed", "HEAD", "--"]).catch(() => undefined);
  }
}

export async function applyApprovedPhaseToIntegration(state: SequentialWorkflowState, phaseId: string): Promise<{ state: SequentialWorkflowState; result: Omit<IntegrationOperationResult, "state"> }> {
  if (!state.git) throw new GitWorkspaceError("workspace_not_initialized", "Workflow has no Git workspace state.");
  if (!state.plan) throw new GitWorkspaceError("missing_plan", "Cannot integrate without a plan.");
  const phase = state.plan.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new GitWorkspaceError("unknown_phase", `Unknown phase: ${phaseId}`);
  if (phase.status !== "completed" || !phase.completion?.gitEvidence) {
    return { state, result: { ok: false, code: "integration_rejected", phaseId, nextAction: "complete_phase_gate" } };
  }
  if (state.git.integration.integratedPhaseIds.includes(phaseId)) {
    return { state, result: { ok: true, code: "already_integrated", phaseId, integrationHead: state.git.integration.headCommit } };
  }
  const missingDependencies = dependencyIds(phase).filter((dependency) => !state.git!.integration.integratedPhaseIds.includes(dependency));
  if (missingDependencies.length > 0) {
    throw new GitWorkspaceError("integration_order_violation", `Phase ${phaseId} dependencies are not integrated: ${missingDependencies.join(", ")}`, { missingDependencies });
  }
  const evidence = phase.completion.gitEvidence;
  const workspace = state.git.phaseWorkspaces[phaseId];
  if (!workspace || workspace.path !== evidence.workspacePath) throw new GitWorkspaceError("phase_workspace_evidence_mismatch", "Phase workspace does not match approved Git evidence.");
  if (evidence.validationCommitOrPatch) {
    const actual = (await git(workspace.path, ["rev-parse", "HEAD"])).trim();
    if (actual !== evidence.validationCommitOrPatch) throw new GitWorkspaceError("phase_diff_identity_mismatch", "Phase workspace HEAD no longer matches approved Git evidence.");
  }

  await requireCleanIntegrationWorkspace(state.git);
  const next = structuredClone(state);
  const gitState = next.git!;
  gitState.integration.status = "integration_pending";

  if (!evidence.validationCommitOrPatch) {
    gitState.integration.integratedPhaseIds = stableUnique([...gitState.integration.integratedPhaseIds, phaseId]);
    gitState.phaseWorkspaces[phaseId] = { ...gitState.phaseWorkspaces[phaseId]!, status: "integrated", updatedAt: timestamp() };
    gitState.integration.status = "ready";
    gitState.integrationValidation = undefined;
    return { state: next, result: { ok: true, code: "integrated", phaseId, integrationHead: gitState.integration.headCommit } };
  }

  try {
    await git(gitState.integration.path, ["cherry-pick", evidence.validationCommitOrPatch], { maxBuffer: MAX_GIT_OUTPUT });
  } catch {
    const conflictingFiles = splitLines(await git(gitState.integration.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).sort();
    gitState.integration.status = "blocked";
    gitState.integration.conflictingPhaseIds = stableUnique([...gitState.integration.conflictingPhaseIds, phaseId]);
    gitState.integration.conflictedFiles = stableUnique([...gitState.integration.conflictedFiles, ...conflictingFiles]);
    gitState.phaseWorkspaces[phaseId] = { ...gitState.phaseWorkspaces[phaseId]!, status: "conflicted", updatedAt: timestamp() };
    return {
      state: next,
      result: {
        ok: false,
        code: "integration_conflict",
        phaseId,
        conflictingFiles,
        nextAction: "create_conflict_repair"
      }
    };
  }

  const integrationHead = (await git(gitState.integration.path, ["rev-parse", "HEAD"])).trim();
  gitState.integration.headCommit = integrationHead;
  gitState.integration.status = "ready";
  gitState.integration.integratedPhaseIds = stableUnique([...gitState.integration.integratedPhaseIds, phaseId]);
  gitState.integration.conflictingPhaseIds = gitState.integration.conflictingPhaseIds.filter((id) => id !== phaseId);
  gitState.phaseWorkspaces[phaseId] = { ...gitState.phaseWorkspaces[phaseId]!, status: "integrated", updatedAt: timestamp() };
  gitState.integrationValidation = undefined;
  return { state: next, result: { ok: true, code: "integrated", phaseId, integrationHead } };
}

export function integrationStatus(state: SequentialWorkflowState): {
  workflowId: string;
  integrationHead?: string;
  integratedPhaseIds: string[];
  pendingPhaseIds: string[];
  conflictedPhaseIds: string[];
  blockedPhaseIds: string[];
  validation?: IntegrationValidation;
  finalReviewEligible: boolean;
} {
  const integrated = state.git?.integration.integratedPhaseIds ?? [];
  const conflicted = state.git?.integration.conflictingPhaseIds ?? [];
  const completed = state.plan?.phases.filter((phase) => phase.status === "completed").map((phase) => phase.id) ?? [];
  const pending = completed.filter((id) => !integrated.includes(id) && !conflicted.includes(id));
  const blocked = state.plan ? pending.filter((id) => dependencyIds(state.plan!.phases.find((phase) => phase.id === id)).some((dependency) => conflicted.includes(dependency))) : [];
  const validation = state.git?.integrationValidation;
  const finalReviewEligible = Boolean(
    state.git &&
    completed.length > 0 &&
    pending.length === 0 &&
    conflicted.length === 0 &&
    state.plan?.phases.every((phase) => phase.status === "completed") &&
    validation?.status === "passed" &&
    validation.integrationCommit === state.git.integration.headCommit
  );
  return {
    workflowId: state.id,
    integrationHead: state.git?.integration.headCommit,
    integratedPhaseIds: integrated,
    pendingPhaseIds: pending,
    conflictedPhaseIds: conflicted,
    blockedPhaseIds: blocked,
    validation,
    finalReviewEligible
  };
}

export async function runIntegrationValidation(state: SequentialWorkflowState): Promise<SequentialWorkflowState> {
  if (!state.git) throw new GitWorkspaceError("workspace_not_initialized", "Workflow has no Git workspace state.");
  if (!state.plan) throw new GitWorkspaceError("missing_plan", "Cannot validate integration without a plan.");
  const status = integrationStatus(state);
  if (status.pendingPhaseIds.length > 0 || status.conflictedPhaseIds.length > 0) {
    throw new GitWorkspaceError("integration_not_ready_for_validation", "All completed phases must be integrated before combined validation.", status);
  }
  await requireCleanIntegrationWorkspace(state.git);
  const startedAt = timestamp();
  const commands = stableUnique(state.plan.phases.flatMap((phase) => phase.validationCommands));
  const evidence: ValidationEvidence[] = [];
  if (commands.length === 0) {
    evidence.push({
      command: "combined validation",
      exitStatus: null,
      result: "No workflow-level validation commands were declared.",
      status: "skipped",
      skipped: true,
      skippedReason: "No validation commands declared by the approved plan.",
      timestamp: timestamp()
    });
  } else {
    for (const command of commands) {
      const result = await runShellCommand(command, state.git.integration.path);
      evidence.push({
        command,
        exitStatus: result.exitStatus,
        result: result.output.slice(0, 4000),
        status: result.exitStatus === 0 ? "passed" : "failed",
        skipped: false,
        timestamp: timestamp()
      });
    }
  }
  const failed = evidence.some((item) => item.status === "failed");
  const skippedOnly = evidence.length > 0 && evidence.every((item) => item.status === "skipped");
  const next = structuredClone(state);
  next.git!.integrationValidation = {
    integrationCommit: next.git!.integration.headCommit,
    commands: evidence,
    startedAt,
    completedAt: timestamp(),
    status: failed ? "failed" : skippedOnly ? "skipped" : "passed"
  };
  next.git!.integration.status = failed ? "needs_repair" : "ready_for_final_review";
  return next;
}

export async function cleanupOwnedWorkspaces(state: SequentialWorkflowState, mode: WorkspaceCleanupReport["mode"]): Promise<WorkspaceCleanupReport> {
  const report: WorkspaceCleanupReport = { workflowId: state.id, mode, removedWorktrees: [], retainedWorktrees: [], removedBranches: [], needsReview: [] };
  if (!state.git) return report;
  const phases = Object.values(state.git.phaseWorkspaces);
  for (const workspace of phases) {
    const owned = await ownedWorktreeExists(workspace.path, state.id, "phase", workspace.phaseId);
    if (!owned) {
      report.retainedWorktrees.push({ path: workspace.path, reason: "ownership metadata missing or mismatched" });
      report.needsReview.push(workspace.path);
      continue;
    }
    const dirty = await worktreeDirty(workspace.path);
    if (dirty) {
      report.retainedWorktrees.push({ path: workspace.path, reason: "workspace contains unrecorded changes" });
      continue;
    }
    if (mode === "archive") {
      report.retainedWorktrees.push({ path: workspace.path, reason: "archive mode preserves owned worktrees in place for manual archival" });
      continue;
    }
    const phase = state.plan?.phases.find((candidate) => candidate.id === workspace.phaseId);
    if (mode === "safe" && (workspace.status !== "integrated" || phase?.status !== "completed")) {
      report.retainedWorktrees.push({ path: workspace.path, reason: "phase is not integrated" });
      continue;
    }
    await git(state.git.context.repositoryRoot, ["worktree", "remove", workspace.path]).catch((error) => {
      throw new GitWorkspaceError("workspace_remove_failed", String(error), { path: workspace.path });
    });
    report.removedWorktrees.push(workspace.path);
    if (workspace.status === "integrated") {
      await git(state.git.context.repositoryRoot, ["branch", "-D", workspace.branch]).then(() => report.removedBranches.push(workspace.branch)).catch(() => undefined);
    }
  }
  report.retainedWorktrees.push({ path: state.git.integration.path, reason: "integration workspace retained by default" });
  return report;
}

export async function workspaceStatus(state: SequentialWorkflowState, config: LeanRigorConfig): Promise<WorkspaceStatus> {
  return {
    workflowId: state.id,
    git: state.git,
    preflight: await preflightGitRepository(state.root, config),
    phaseWorkspaces: Object.values(state.git?.phaseWorkspaces ?? {})
  };
}

export async function recoverWorkspaceState(state: SequentialWorkflowState): Promise<WorkspaceRecoveryReport> {
  const next = structuredClone(state);
  const facts: string[] = [];
  const needsReview: string[] = [];
  if (!next.git) return { workflowId: next.id, facts: ["No Git workspace state is persisted."], needsReview, state: next };
  for (const workspace of Object.values(next.git.phaseWorkspaces)) {
    const exists = await pathExists(workspace.path);
    const owned = exists && await ownedWorktreeExists(workspace.path, next.id, "phase", workspace.phaseId);
    if (!exists) {
      facts.push(`Phase workspace missing: ${workspace.phaseId}`);
      workspace.status = "abandoned";
      needsReview.push(workspace.phaseId);
      continue;
    }
    if (!owned) {
      facts.push(`Phase workspace ownership uncertain: ${workspace.phaseId}`);
      workspace.status = "needs_repair";
      needsReview.push(workspace.phaseId);
      continue;
    }
    const lease = next.phaseLeases[workspace.phaseId];
    if (lease && !lease.releasedAt && Date.parse(lease.expiresAt) <= Date.now() && await worktreeDirty(workspace.path)) {
      const phase = next.plan?.phases.find((candidate) => candidate.id === workspace.phaseId);
      if (phase && phase.status !== "completed") phase.status = "needs_review";
      workspace.status = "abandoned";
      facts.push(`Expired lease preserved with workspace changes: ${workspace.phaseId}`);
      needsReview.push(workspace.phaseId);
    }
  }
  if (!await ownedWorktreeExists(next.git.integration.path, next.id, "integration")) {
    facts.push("Integration workspace missing or ownership uncertain.");
    next.git.integration.status = "needs_review";
    needsReview.push("integration");
  }
  return { workflowId: next.id, facts, needsReview, state: next };
}

async function requirePreflight(root: string, config: LeanRigorConfig): Promise<Required<Pick<GitPreflightResult, "repositoryRoot" | "gitCommonDir" | "baseCommit" | "originalHead" | "workspaceRoot">> & GitPreflightResult> {
  const preflight = await preflightGitRepository(root, config);
  if (!preflight.ok) throw new GitWorkspaceError(preflight.code ?? "git_preflight_failed", preflight.message ?? "Git preflight failed.", preflight as unknown as Record<string, unknown>);
  return preflight as Required<Pick<GitPreflightResult, "repositoryRoot" | "gitCommonDir" | "baseCommit" | "originalHead" | "workspaceRoot">> & GitPreflightResult;
}

async function requireCleanIntegrationWorkspace(gitState: WorkflowGitState): Promise<void> {
  const gitDir = await resolveGitPath(gitState.integration.path, (await git(gitState.integration.path, ["rev-parse", "--git-dir"])).trim());
  const commonDir = await resolveGitPath(gitState.integration.path, (await git(gitState.integration.path, ["rev-parse", "--git-common-dir"])).trim());
  const operation = await gitOperationInProgress(commonDir, gitDir);
  if (operation) throw new GitWorkspaceError("git_operation_in_progress", `Integration workspace has an active Git operation: ${operation}`, { operation });
  if (await worktreeDirty(gitState.integration.path)) {
    throw new GitWorkspaceError("integration_workspace_dirty", "Integration workspace has uncommitted changes and needs review.");
  }
}

async function addWorktree(repositoryRoot: string, worktreePath: string, branch: string, startPoint: string, createBranch: boolean): Promise<void> {
  const args = createBranch
    ? ["worktree", "add", "-b", branch, worktreePath, startPoint]
    : ["worktree", "add", worktreePath, startPoint];
  await git(repositoryRoot, args, { maxBuffer: MAX_GIT_OUTPUT });
}

async function ensureBranchAvailable(repositoryRoot: string, branch: string, alreadyOwned: boolean): Promise<boolean> {
  const exists = await git(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true).catch(() => false);
  if (exists && !alreadyOwned) throw new GitWorkspaceError("branch_collision", `Branch already exists and is not recorded as LeanRigor-owned: ${branch}`, { branch });
  return exists;
}

async function ensurePathAvailable(targetPath: string, workflowId: string, workspaceType: "integration" | "phase", phaseId?: string): Promise<void> {
  if (!await pathExists(targetPath)) return;
  if (await ownedWorktreeExists(targetPath, workflowId, workspaceType, phaseId)) return;
  throw new GitWorkspaceError("workspace_path_collision", `Workspace path already exists and is not verified as LeanRigor-owned: ${targetPath}`, { path: targetPath });
}

function ensurePathLength(targetPath: string, config: LeanRigorConfig): void {
  if (targetPath.length > config.execution.maxWorkspacePathLength) {
    throw new GitWorkspaceError("workspace_path_too_long", `Workspace path exceeds maxWorkspacePathLength: ${targetPath}`, { path: targetPath });
  }
}

function workspaceNames(workflowId: string, phaseId: string | undefined, config: LeanRigorConfig): { integrationBranch: string; phaseBranch?: string; phasePathSegment?: string } {
  const prefix = sanitizeRefSegment(config.execution.workspaceBranchPrefix).slice(0, 48) || "leanrigor";
  const workflow = sanitizeRefSegment(workflowId).slice(0, 32);
  const integrationBranch = `${prefix}/${workflow}/integration`;
  if (!phaseId) return { integrationBranch };
  const phase = sanitizeRefSegment(phaseId).slice(0, 64);
  return { integrationBranch, phaseBranch: `${prefix}/${workflow}/${phase}`, phasePathSegment: phase };
}

function sanitizeRefSegment(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/[~^:?*[\]\s]+/g, "-")
    .replace(/@{/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[/.-]+|[/.-]+$/g, "")
    .replace(/\/+/g, "/")
    .replace(/\.lock$/i, "-lock") || "workspace";
}

function resolveWorkspaceRoot(repositoryRoot: string, config: LeanRigorConfig): string {
  if (config.execution.workspaceRoot) return path.resolve(repositoryRoot, config.execution.workspaceRoot);
  return path.join(path.dirname(repositoryRoot), ".leanrigor-worktrees", path.basename(repositoryRoot));
}

async function writeOwnershipMetadata(workflowRoot: string, metadata: OwnershipMetadata): Promise<void> {
  const dir = path.join(workflowRoot, ".leanrigor-owned-worktrees");
  await mkdir(dir, { recursive: true });
  const name = metadata.workspaceType === "integration" ? "integration.json" : `phase-${sanitizeRefSegment(metadata.phaseId ?? "unknown")}.json`;
  await writeFile(path.join(dir, name), JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

async function readOwnershipMetadata(worktreePath: string, workflowId: string, workspaceType: "integration" | "phase", phaseId?: string): Promise<OwnershipMetadata | undefined> {
  const workflowRoot = workspaceType === "integration" ? path.dirname(worktreePath) : path.dirname(path.dirname(worktreePath));
  const name = workspaceType === "integration" ? "integration.json" : `phase-${sanitizeRefSegment(phaseId ?? path.basename(worktreePath))}.json`;
  const file = path.join(workflowRoot, ".leanrigor-owned-worktrees", name);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as OwnershipMetadata;
    if (parsed.generatedBy !== "leanrigor" || parsed.workflowId !== workflowId || parsed.workspaceType !== workspaceType) return undefined;
    if (phaseId && parsed.phaseId !== phaseId) return undefined;
    if (path.resolve(parsed.path) !== path.resolve(worktreePath)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function ownedWorktreeExists(worktreePath: string, workflowId: string, workspaceType: "integration" | "phase", phaseId?: string): Promise<boolean> {
  if (!await pathExists(worktreePath)) return false;
  return Boolean(await readOwnershipMetadata(worktreePath, workflowId, workspaceType, phaseId));
}

async function worktreeDirty(worktreePath: string): Promise<boolean> {
  const statusText = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "dirty");
  return statusText.trim().length > 0;
}

async function git(cwd: string, args: string[], options: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024 });
  return stdout;
}

async function runShellCommand(command: string, cwd: string): Promise<{ exitStatus: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT });
    return { exitStatus: 0, output: `${stdout}${stderr}`.trim() || "Command completed successfully." };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { exitStatus: typeof failed.code === "number" ? failed.code : 1, output: `${failed.stdout ?? ""}${failed.stderr ?? failed.message ?? ""}`.trim() };
  }
}

async function gitOperationInProgress(commonDir: string, gitDir: string): Promise<string | undefined> {
  const checks: Array<[string, string]> = [
    [path.join(gitDir, "MERGE_HEAD"), "merge"],
    [path.join(gitDir, "CHERRY_PICK_HEAD"), "cherry-pick"],
    [path.join(gitDir, "REVERT_HEAD"), "revert"],
    [path.join(gitDir, "BISECT_LOG"), "bisect"],
    [path.join(gitDir, "rebase-merge"), "rebase"],
    [path.join(gitDir, "rebase-apply"), "rebase"],
    [path.join(commonDir, "rebase-merge"), "rebase"],
    [path.join(commonDir, "rebase-apply"), "rebase"]
  ];
  for (const [file, operation] of checks) {
    if (await pathExists(file)) return operation;
  }
  return undefined;
}

async function resolveGitPath(cwd: string, gitPath: string): Promise<string> {
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
}

async function canonical(value: string): Promise<string> {
  return realpath(path.resolve(value));
}

function gitVersionSupportsWorktree(versionText: string): boolean {
  const match = versionText.match(/git version (\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  return major > 2 || (major === 2 && minor >= 20);
}

async function findNestedRepositories(repositoryRoot: string): Promise<string[]> {
  const nested: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || nested.length > 10) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || [".git", "node_modules", "dist", ".leanrigor", ".codegraph"].includes(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (await pathExists(path.join(child, ".git"))) {
        nested.push(path.relative(repositoryRoot, child));
        continue;
      }
      await walk(child, depth + 1);
    }
  }
  await walk(repositoryRoot, 0);
  return nested;
}

function parsePorcelain(raw: string): GitStatusEntry[] {
  const parts = splitNul(raw);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index]!;
    if (item.length < 4) continue;
    const entry: GitStatusEntry = { index: item[0]!, workingTree: item[1]!, path: item.slice(3) };
    if (entry.index === "R" || entry.index === "C") {
      entry.originalPath = parts[index + 1];
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function parseBinaryFiles(raw: string): string[] {
  const parts = splitNul(raw);
  const files: string[] = [];
  for (let index = 0; index + 2 < parts.length; index += 3) {
    if (parts[index] === "-" && parts[index + 1] === "-") files.push(parts[index + 2]!);
  }
  return files.sort();
}

function parseModeChanges(raw: string): string[] {
  return splitLines(raw)
    .filter((line) => /mode change|create mode|delete mode/.test(line))
    .map((line) => line.trim())
    .sort();
}

async function rejectUnsafeSymlinks(worktreePath: string, changedFiles: string[]): Promise<void> {
  for (const file of changedFiles) {
    const full = path.join(worktreePath, file);
    let info;
    try {
      info = await lstat(full);
    } catch {
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    const target = await readlink(full);
    if (path.isAbsolute(target) || target.split(/[\\/]+/).includes("..")) {
      throw new GitWorkspaceError("unsafe_symlink", `Changed symlink escapes the repository: ${file}`, { file, target });
    }
  }
}

function splitNul(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function timestamp(): string {
  return new Date().toISOString();
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}
