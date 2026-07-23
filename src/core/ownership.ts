import path from "node:path";
import type { LeanRigorConfig } from "../config/schema.js";
import type { WorkflowMode, WorkflowPhase } from "./types.js";

export interface FileLease {
  path: string;
  taskId: string;
  agentId?: string;
  acquiredAt: string;
}

export interface OwnershipConflict {
  phaseA: string;
  phaseB: string;
  kind: "write_write" | "write_read" | "sensitive_shared";
  paths: string[];
  severity: "blocking" | "review";
}

export const DEFAULT_SENSITIVE_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig*.json",
  ".git/**",
  ".github/**",
  "migrations/**",
  "schema/**",
  "infra/**"
];

export class OwnershipPatternError extends Error {}

export class FileOwnershipRegistry {
  private readonly leases = new Map<string, FileLease>();

  acquire(taskId: string, paths: string[], agentId?: string): void {
    const conflicts = paths.filter((rawPath) => {
      const lease = this.leases.get(normalizeOwnershipPattern(rawPath));
      return lease && lease.taskId !== taskId;
    });
    if (conflicts.length > 0) throw new Error(`Files already owned: ${conflicts.join(", ")}`);

    const acquiredAt = new Date().toISOString();
    for (const rawPath of paths) {
      const normalized = normalizeOwnershipPattern(rawPath);
      this.leases.set(normalized, { path: normalized, taskId, agentId, acquiredAt });
    }
  }

  assertCanWrite(taskId: string, rawPath: string): void {
    const normalized = normalizeOwnershipPattern(rawPath);
    const lease = this.leases.get(normalized);
    if (!lease || lease.taskId !== taskId) throw new Error(`Task ${taskId} does not own ${normalized}.`);
  }

  release(taskId: string): void {
    for (const [leasePath, lease] of this.leases.entries()) {
      if (lease.taskId === taskId) this.leases.delete(leasePath);
    }
  }

  snapshot(): FileLease[] {
    return [...this.leases.values()];
  }
}

export function normalizeOwnershipPattern(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || path.posix.isAbsolute(trimmed) || trimmed.split("/").includes("..")) {
    throw new OwnershipPatternError(`Invalid repository-relative ownership path: ${value}`);
  }
  return trimmed.replace(/\/+/g, "/");
}

export function phaseWriteAreas(phase: WorkflowPhase): string[] {
  return unique((phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas).map(normalizeMaybe));
}

export function phaseReadAreas(phase: WorkflowPhase): string[] {
  return unique((phase.expectedReadAreas.length > 0 ? phase.expectedReadAreas : []).map(normalizeMaybe));
}

export function ownershipIsExplicit(phase: WorkflowPhase, mode: WorkflowMode): boolean {
  const writes = phaseWriteAreas(phase).filter(isPathLikeArea);
  if (mode === "fast") return writes.length > 0 && !phase.ownershipUncertain;
  return writes.length > 0 && phaseReadAreas(phase).length > 0 && !phase.ownershipUncertain;
}

export function detectOwnershipConflicts(phases: WorkflowPhase[], config?: LeanRigorConfig): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];
  for (let i = 0; i < phases.length; i += 1) {
    for (let j = i + 1; j < phases.length; j += 1) {
      const phaseA = phases[i];
      const phaseB = phases[j];
      const writesA = phaseWriteAreas(phaseA);
      const writesB = phaseWriteAreas(phaseB);
      const readsA = phaseReadAreas(phaseA);
      const readsB = phaseReadAreas(phaseB);

      const writeWrite = overlappingPatterns(writesA, writesB);
      if (writeWrite.length > 0) conflicts.push(conflict(phaseA.id, phaseB.id, "write_write", writeWrite, "blocking"));

      const sensitive = sharedSensitive(writesA, writesB, config);
      if (sensitive.length > 0) conflicts.push(conflict(phaseA.id, phaseB.id, "sensitive_shared", sensitive, "blocking"));

      const writeRead = unique([...overlappingPatterns(writesA, readsB), ...overlappingPatterns(writesB, readsA)]);
      if (writeRead.length > 0) {
        conflicts.push(conflict(phaseA.id, phaseB.id, "write_read", writeRead, config?.execution.writeReadConflictsBlock ?? true ? "blocking" : "review"));
      }
    }
  }
  return conflicts;
}

export function patternsOverlap(a: string, b: string): boolean {
  const left = normalizeMaybe(a);
  const right = normalizeMaybe(b);
  if (left === "**" || right === "**") return true;
  if (left === right) return true;
  if (left.endsWith("/**") && right.startsWith(left.slice(0, -3))) return true;
  if (right.endsWith("/**") && left.startsWith(right.slice(0, -3))) return true;
  if (!hasGlob(left) && !hasGlob(right)) {
    return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
  return globMightOverlap(left, right);
}

export function areaMatchesFile(area: string, file: string): boolean {
  const normalArea = normalizeMaybe(area);
  const normalFile = normalizeMaybe(file);
  if (normalArea === "**") return true;
  if (normalArea.endsWith("/**")) return normalFile === normalArea.slice(0, -3) || normalFile.startsWith(normalArea.slice(0, -3) + "/");
  if (normalArea.endsWith("/*")) {
    const prefix = normalArea.slice(0, -1);
    return normalFile.startsWith(prefix) && !normalFile.slice(prefix.length).includes("/");
  }
  if (hasGlob(normalArea)) {
    const pattern = `^${normalArea.split("*").map(escapeRegex).join(".*")}$`;
    return new RegExp(pattern).test(normalFile);
  }
  if (!path.posix.extname(normalArea)) return normalFile === normalArea || normalFile.startsWith(`${normalArea}/`);
  return normalFile === normalArea;
}

export function sensitivePaths(config?: LeanRigorConfig): string[] {
  return unique([...DEFAULT_SENSITIVE_PATHS, ...(config?.execution.sensitivePaths ?? [])].map(normalizeMaybe));
}

function overlappingPatterns(a: string[], b: string[]): string[] {
  const paths: string[] = [];
  for (const left of a) {
    for (const right of b) {
      if (patternsOverlap(left, right)) paths.push(left === right ? left : `${left} <-> ${right}`);
    }
  }
  return unique(paths);
}

function sharedSensitive(a: string[], b: string[], config?: LeanRigorConfig): string[] {
  return sensitivePaths(config).filter((sensitive) => a.some((pattern) => patternsOverlap(pattern, sensitive)) && b.some((pattern) => patternsOverlap(pattern, sensitive)));
}

function conflict(phaseA: string, phaseB: string, kind: OwnershipConflict["kind"], paths: string[], severity: OwnershipConflict["severity"]): OwnershipConflict {
  return { phaseA, phaseB, kind, paths, severity };
}

function globMightOverlap(a: string, b: string): boolean {
  const rootA = a.split("*")[0].replace(/\/$/, "");
  const rootB = b.split("*")[0].replace(/\/$/, "");
  if (!rootA || !rootB) return true;
  return rootA.startsWith(rootB) || rootB.startsWith(rootA);
}

function normalizeMaybe(value: string): string {
  try {
    return normalizeOwnershipPattern(value);
  } catch {
    return value.trim();
  }
}

function isPathLikeArea(area: string): boolean {
  return area.includes("/") || area.includes("*") || /\.[a-z0-9]+$/i.test(area);
}

function hasGlob(value: string): boolean {
  return value.includes("*");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
