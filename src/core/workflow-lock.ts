import { open, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowLock, WorkflowLockOwnerType } from "./types.js";
import { atomicWriteJson } from "./workflow-store.js";

export class WorkflowLockBusyError extends Error {
  readonly code = "workflow_lock_busy";

  constructor(readonly lock: WorkflowLock) {
    super(`Workflow ${lock.workflowId} is locked by ${lock.ownerId} for ${lock.operation} until ${lock.expiresAt}.`);
  }
}

export class WorkflowLockOwnershipError extends Error {
  readonly code = "workflow_lock_owner_mismatch";
}

export interface WorkflowLockOptions {
  root: string;
  workflowId: string;
  ownerId: string;
  ownerType?: WorkflowLockOwnerType;
  operation: string;
  timeoutSeconds: number;
  now?: Date;
}

export function lockPath(root: string, workflowId: string): string {
  return path.join(path.resolve(root), ".leanrigor", "workflows", `${workflowId}.lock.json`);
}

export async function acquireWorkflowLock(options: WorkflowLockOptions): Promise<WorkflowLock> {
  const now = options.now ?? new Date();
  const lock = buildLock(options, now);
  const file = lockPath(options.root, options.workflowId);
  await mkdir(path.dirname(file), { recursive: true });

  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify(lock, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = await readWorkflowLock(options.root, options.workflowId);
  if (!existing) return acquireWorkflowLock(options);
  if (Date.parse(existing.expiresAt) > now.getTime()) throw new WorkflowLockBusyError(existing);

  await rm(file, { force: true });
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify(lock, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const current = await readWorkflowLock(options.root, options.workflowId);
      if (current) throw new WorkflowLockBusyError(current);
    }
    throw error;
  }
}

export async function refreshWorkflowLock(root: string, workflowId: string, ownerId: string, timeoutSeconds: number, now = new Date()): Promise<WorkflowLock> {
  const existing = await requireLock(root, workflowId);
  if (existing.ownerId !== ownerId) throw new WorkflowLockOwnershipError(`Workflow lock is owned by ${existing.ownerId}, not ${ownerId}.`);
  const refreshed: WorkflowLock = {
    ...existing,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutSeconds * 1000).toISOString()
  };
  await atomicWriteJson(lockPath(root, workflowId), refreshed);
  return refreshed;
}

export async function releaseWorkflowLock(root: string, workflowId: string, ownerId: string): Promise<void> {
  const existing = await readWorkflowLock(root, workflowId);
  if (!existing) return;
  if (existing.ownerId !== ownerId) throw new WorkflowLockOwnershipError(`Workflow lock is owned by ${existing.ownerId}, not ${ownerId}.`);
  await rm(lockPath(root, workflowId), { force: true });
}

export async function readWorkflowLock(root: string, workflowId: string): Promise<WorkflowLock | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(root, workflowId), "utf8")) as WorkflowLock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeWorkflowLock(root: string, lock: WorkflowLock): Promise<void> {
  await mkdir(path.dirname(lockPath(root, lock.workflowId)), { recursive: true });
  await writeFile(lockPath(root, lock.workflowId), JSON.stringify(lock, null, 2) + "\n", { flag: "wx" });
}

async function requireLock(root: string, workflowId: string): Promise<WorkflowLock> {
  const lock = await readWorkflowLock(root, workflowId);
  if (!lock) throw new WorkflowLockOwnershipError(`Workflow ${workflowId} is not locked.`);
  return lock;
}

function buildLock(options: WorkflowLockOptions, now: Date): WorkflowLock {
  return {
    workflowId: options.workflowId,
    ownerId: options.ownerId,
    ownerType: options.ownerType ?? "cli",
    operation: options.operation,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.timeoutSeconds * 1000).toISOString(),
    processId: process.pid,
    host: os.hostname()
  };
}
