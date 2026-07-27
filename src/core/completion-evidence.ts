import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resumeFlow } from "./flow.js";
import type { CriterionCompletionEvidence, PhaseCompletionRecord, SequentialWorkflowState, ValidationEvidence } from "./types.js";

export interface CompletionEvidenceFile {
  workflowId?: string;
  workflowRevision?: number;
  phaseId?: string;
  generatedAt?: string;
  criteria?: CriterionCompletionEvidence[];
  filesChanged?: string[];
  commandsRun?: string[];
  validation?: Array<Partial<ValidationEvidence> & { command: string; result?: string; exitStatus?: number | null; skipped?: boolean; skippedReason?: string }>;
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  requestedRepairScope?: string;
  modelDecision?: "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
}

export async function readCompletionEvidenceFile(root: string, workflowId: string, phaseId: string, file: string): Promise<Omit<CompletionEvidenceFile, "validation"> & { validation?: ValidationEvidence[] }> {
  const resolved = path.resolve(file);
  let rawText: string;
  try {
    rawText = await readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`Completion evidence file is unavailable: ${resolved}`, { cause: error });
  }
  let raw: CompletionEvidenceFile;
  try {
    raw = JSON.parse(rawText) as CompletionEvidenceFile;
  } catch (error) {
    throw new Error(`Completion evidence file is not valid JSON: ${resolved}`, { cause: error });
  }
  validateCompletionEvidenceFile(raw, await resumeFlow(root, workflowId), phaseId, resolved);
  return {
    ...raw,
    validation: raw.validation?.map((entry) => {
      const skipped = Boolean(entry.skipped);
      const exitStatus = skipped ? null : entry.exitStatus ?? 0;
      return {
        phaseId: entry.phaseId,
        command: entry.command,
        exitStatus,
        result: entry.result ?? (skipped ? "Validation skipped." : "Validation command recorded."),
        status: skipped ? "skipped" : exitStatus === 0 ? "passed" : "failed",
        skipped,
        skippedReason: entry.skippedReason,
        timestamp: entry.timestamp ?? new Date().toISOString()
      };
    })
  };
}

export function validateCompletionEvidenceFile(raw: CompletionEvidenceFile, state: SequentialWorkflowState, phaseId: string, file: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Completion evidence file must contain a JSON object: ${file}`);
  const meaningfulKeys = Object.keys(raw).filter((key) => !key.startsWith("_"));
  if (meaningfulKeys.length === 0) throw new Error(`Completion evidence file is empty: ${file}`);
  if (raw.workflowId && raw.workflowId !== state.id) throw new Error(`Completion evidence workflowId ${raw.workflowId} does not match ${state.id}.`);
  if (raw.phaseId && raw.phaseId !== phaseId) throw new Error(`Completion evidence phaseId ${raw.phaseId} does not match ${phaseId}.`);
  if (raw.workflowRevision !== undefined && raw.workflowRevision !== state.revision) {
    throw new Error(`Completion evidence revision ${raw.workflowRevision} is stale; current workflow revision is ${state.revision}.`);
  }
  if (raw.criteria !== undefined && !Array.isArray(raw.criteria)) throw new Error("Completion evidence criteria must be an array.");
  if (raw.validation !== undefined && !Array.isArray(raw.validation)) throw new Error("Completion evidence validation must be an array.");
}

export async function persistCompletionEvidenceArtifact(root: string, workflowId: string, phaseId: string, file: string): Promise<PhaseCompletionRecord["evidenceArtifact"]> {
  const sourcePath = path.resolve(file);
  const raw = await readFile(sourcePath, "utf8");
  const artifactPath = completionEvidenceArtifactPath(root, workflowId, phaseId);
  const artifactDir = path.dirname(artifactPath);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
  return { path: artifactPath, sourcePath, recordedAt: new Date().toISOString() };
}

export function completionEvidenceArtifactPath(root: string, workflowId: string, phaseId: string): string {
  return path.resolve(root, ".leanrigor", "workflows", workflowId, "artifacts", `${phaseId}-completion-evidence.json`);
}
