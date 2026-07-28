import { describe, expect, it } from "vitest";
import { validatePlanQuality } from "../src/core/flow.js";
import { repairPhaseGraphDependencies, validatePhaseGraphQuality } from "../src/core/phase-graph-quality.js";
import type { ExecutionPlan, WorkflowPhase } from "../src/core/types.js";

describe("phase graph closure", () => {
  it("rejects acceptance that depends on a symbol introduced by a later phase", () => {
    const plan = planOf([
      phase("consumer", "Exercise the consumer", ["src/consumer.ts"], [], [
        "A focused test exercises `ParserV2` and records a passing result."
      ]),
      phase("producer", "Introduce ParserV2", ["src/parser.ts"])
    ]);

    expect(validatePhaseGraphQuality(plan)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "closure.future_dependency", affectedPhase: "consumer" })
    ]));
  });

  it("detects invalid ordering before phase approval", () => {
    const plan = planOf([
      phase("validate", "Validate the migrated consumer", ["src/consumer.ts"], [], [
        "A focused compatibility check loads state through `StateSchemaV3` and records the result."
      ]),
      phase("schema", "Introduce StateSchemaV3", ["src/schema.ts"])
    ]);

    expect(validatePlanQuality(plan, "rigorous").join("\n")).toContain("introduced by later phase schema");
  });

  it("repairs a missing dependency when the producer is already earlier", () => {
    const plan = planOf([
      phase("schema", "Introduce StateSchemaV3", ["src/schema.ts"]),
      phase("consumer", "Load the new state", ["src/consumer.ts"], [], [
        "A focused compatibility check loads state through `StateSchemaV3` and records the result."
      ])
    ]);

    const repaired = repairPhaseGraphDependencies(plan);

    expect(repaired.changed).toBe(true);
    expect(repaired.plan.phases[1].dependencies).toEqual(["schema"]);
    expect(validatePhaseGraphQuality(repaired.plan).map((item) => item.code)).not.toContain("dependency.unlinked_producer");
  });

  it("fails closed on circular dependencies", () => {
    const plan = planOf([
      phase("one", "First bounded change", ["src/one.ts"], ["two"]),
      phase("two", "Second bounded change", ["src/two.ts"], ["one"])
    ]);

    expect(validatePlanQuality(plan)).toContain("Dependency cycle detected at one.");
  });

  it("requires every implementation phase to establish an independently valid state", () => {
    const candidate = phase("change", "Change runtime behaviour", ["src/change.ts"]);
    candidate.validationCommands = [];

    expect(validatePhaseGraphQuality(planOf([candidate]))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "closure.validation_missing" })
    ]));
  });

  it("does not impose an irrelevant build check on a documentation-only phase", () => {
    const docs = phase("docs", "Document the public command", ["docs/command.md"], [], [
      "A documentation check verifies the rendered example and records that its links resolve."
    ]);
    docs.validationCommands = ["git diff --check -- docs/command.md"];

    expect(validatePhaseGraphQuality(planOf([docs]))).toEqual([]);
  });

  it("orders overlapping write boundaries deterministically", () => {
    const plan = planOf([
      phase("producer", "Add the producer", ["src/core"]),
      phase("consumer", "Add the consumer", ["src/core/consumer.ts"])
    ]);

    expect(validatePhaseGraphQuality(plan).map((item) => item.code)).toContain("dependency.write_boundary_overlap");
    expect(repairPhaseGraphDependencies(plan).plan.phases[1].dependencies).toEqual(["producer"]);
  });
});

function planOf(phases: WorkflowPhase[]): ExecutionPlan {
  return {
    version: 1,
    summary: "A bounded plan with independently valid phases.",
    principles: ["Each phase validates its approved boundary."],
    phases,
    revisionRequests: []
  };
}

function phase(
  id: string,
  objective: string,
  areas: string[],
  dependencies: string[] = [],
  acceptanceCriteria = ["A focused repository test records a passing observable result."]
): WorkflowPhase {
  return {
    id,
    objective,
    rationale: "This boundary leaves the repository independently valid after its focused check passes.",
    dependencies,
    dependsOn: [...dependencies],
    expectedReadAreas: areas,
    expectedWriteAreas: areas,
    expectedFilesOrAreas: areas,
    acceptanceCriteria,
    validationCommands: ["npm test -- --runInBand"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "planned",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}
