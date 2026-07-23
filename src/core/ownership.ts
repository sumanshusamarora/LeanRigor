export interface FileLease {
  path: string;
  taskId: string;
  agentId?: string;
  acquiredAt: string;
}

export class FileOwnershipRegistry {
  private readonly leases = new Map<string, FileLease>();

  acquire(taskId: string, paths: string[], agentId?: string): void {
    const conflicts = paths.filter((path) => {
      const lease = this.leases.get(path);
      return lease && lease.taskId !== taskId;
    });
    if (conflicts.length > 0) throw new Error(`Files already owned: ${conflicts.join(", ")}`);

    const acquiredAt = new Date().toISOString();
    for (const path of paths) this.leases.set(path, { path, taskId, agentId, acquiredAt });
  }

  assertCanWrite(taskId: string, path: string): void {
    const lease = this.leases.get(path);
    if (!lease || lease.taskId !== taskId) throw new Error(`Task ${taskId} does not own ${path}.`);
  }

  release(taskId: string): void {
    for (const [path, lease] of this.leases.entries()) {
      if (lease.taskId === taskId) this.leases.delete(path);
    }
  }

  snapshot(): FileLease[] {
    return [...this.leases.values()];
  }
}
