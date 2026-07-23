import { describe, expect, it } from "vitest";
import { executionWaves, GraphValidationError, validateGraph } from "../src/core/execution-graph.js";
import type { ExecutionGraph } from "../src/core/types.js";

const task = (id: string, writes: string[], dependsOn: string[] = []) => ({ id, objective: id, reads: [], writes, dependsOn, validation: [], status: "pending" as const });

describe("execution graph", () => {
  it("parallelises disjoint writes", () => {
    const graph: ExecutionGraph = { version: 1, tasks: [task("a", ["a.ts"]), task("b", ["b.ts"])] };
    expect(executionWaves(graph)[0]).toHaveLength(2);
  });

  it("separates conflicting writes", () => {
    const graph: ExecutionGraph = { version: 1, tasks: [task("a", ["shared.ts"]), task("b", ["shared.ts"])] };
    expect(executionWaves(graph)).toHaveLength(2);
  });

  it("rejects cycles", () => {
    const graph: ExecutionGraph = { version: 1, tasks: [task("a", [], ["b"]), task("b", [], ["a"])] };
    expect(() => validateGraph(graph)).toThrow(GraphValidationError);
  });
});
