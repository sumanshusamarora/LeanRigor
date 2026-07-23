import type { ExecutionGraph, ExecutionTask } from "./types.js";

export class GraphValidationError extends Error {}

export function validateGraph(graph: ExecutionGraph): void {
  const ids = new Set(graph.tasks.map((task) => task.id));
  if (ids.size !== graph.tasks.length) throw new GraphValidationError("Task IDs must be unique.");

  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new GraphValidationError(`Task ${task.id} depends on missing task ${dependency}.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));

  const visit = (id: string): void => {
    if (visiting.has(id)) throw new GraphValidationError(`Dependency cycle detected at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of graph.tasks) visit(task.id);
}

export function writeConflict(a: ExecutionTask, b: ExecutionTask): string[] {
  const writesB = new Set(b.writes);
  return a.writes.filter((path) => writesB.has(path));
}

export function executionWaves(graph: ExecutionGraph): ExecutionTask[][] {
  validateGraph(graph);
  const completed = new Set<string>();
  const remaining = new Map(graph.tasks.map((task) => [task.id, task]));
  const waves: ExecutionTask[][] = [];

  while (remaining.size > 0) {
    const candidates = [...remaining.values()].filter((task) => task.dependsOn.every((id) => completed.has(id)));
    if (candidates.length === 0) throw new GraphValidationError("No executable tasks remain; graph may be invalid.");

    const wave: ExecutionTask[] = [];
    for (const candidate of candidates) {
      if (wave.every((existing) => writeConflict(existing, candidate).length === 0)) wave.push(candidate);
    }

    for (const task of wave) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
    waves.push(wave);
  }
  return waves;
}
