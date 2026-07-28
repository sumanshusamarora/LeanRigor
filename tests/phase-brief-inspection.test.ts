import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  derivePhaseBriefInspectionRequest,
  inspectPhaseBrief,
  type PhaseBriefInspectionIo
} from "../src/core/phase-brief-inspection.js";
import type { SequentialWorkflowState, WorkflowPhase } from "../src/core/types.js";

describe("bounded phase brief inspection", () => {
  it("is read-only, enforces approved paths, and records controlled scope expansion", async () => {
    const fixture = await inspectionFixture();
    const sourceBefore = await readFile(path.join(fixture.root, "src", "feature.ts"), "utf8");
    const sourceMode = (await stat(path.join(fixture.root, "src", "feature.ts"))).mode;
    const request = derivePhaseBriefInspectionRequest(fixture.state, fixture.phase, fixture.config);

    const inspected = await inspectPhaseBrief({
      root: fixture.root,
      state: fixture.state,
      phase: fixture.phase,
      request
    });

    expect(await readFile(path.join(fixture.root, "src", "feature.ts"), "utf8")).toBe(sourceBefore);
    expect((await stat(path.join(fixture.root, "src", "feature.ts"))).mode).toBe(sourceMode);
    expect(inspected.result.filesRead).toContain("src/feature.ts");
    expect(inspected.result.filesRead).toContain("src/contract.ts");
    expect(inspected.result.filesRead).not.toContain("private/unrelated.ts");
    expect(inspected.request.scopeExpansions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src", sourcePath: "src/feature.ts", readOnly: true }),
      expect.objectContaining({ path: "tests", readOnly: true })
    ]));
    expect(inspected.result.relevantSymbols).toEqual(expect.arrayContaining([
      "src/feature.ts#applyFeature",
      "src/contract.ts#FeatureContract"
    ]));
  });

  it("enforces read and byte limits", async () => {
    const fixture = await inspectionFixture();
    const request = derivePhaseBriefInspectionRequest(fixture.state, fixture.phase, fixture.config);
    request.maxReads = 1;
    request.maxBytes = 40;

    const inspected = await inspectPhaseBrief({
      root: fixture.root,
      state: fixture.state,
      phase: fixture.phase,
      request
    });

    expect(inspected.result.filesRead).toHaveLength(1);
    expect(inspected.result.bytesRead).toBeLessThanOrEqual(40);
    expect(inspected.result.warnings.join("\n")).toMatch(/read limit|byte limit/i);
  });

  it("enforces the timeout without broadening scope", async () => {
    const phase = testPhase();
    const state = minimalState("/repo", phase);
    const io: PhaseBriefInspectionIo = {
      async list() {
        return [];
      },
      async stat(file) {
        return { isDirectory: false, isFile: file.endsWith("feature.ts"), size: 100 };
      },
      async realpath(file) {
        return file;
      },
      async read() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return Buffer.from("export function applyFeature() {}");
      }
    };
    const request = {
      ...derivePhaseBriefInspectionRequest(state, phase, defaultConfig()),
      allowedPaths: ["src/feature.ts"],
      scopeExpansions: [],
      timeoutSeconds: 0.001
    };

    const inspected = await inspectPhaseBrief({ root: "/repo", state, phase, request, io });

    expect(inspected.result.status).toBe("failed");
    expect(inspected.result.filesRead).toEqual([]);
    expect(inspected.result.warnings.join("\n")).toMatch(/timeout/i);
    expect(inspected.request.allowedPaths).toEqual(["src/feature.ts"]);
  });

  it("reports unavailable inspection when no approved path can be read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "leanrigor-brief-empty-"));
    const phase = testPhase();
    const state = minimalState(root, phase);
    const request = {
      ...derivePhaseBriefInspectionRequest(state, phase, defaultConfig()),
      allowedPaths: ["src/missing.ts"],
      scopeExpansions: []
    };

    const inspected = await inspectPhaseBrief({ root, state, phase, request });

    expect(inspected.result.status).toBe("unavailable");
    expect(inspected.result.filesRead).toEqual([]);
    expect(inspected.result.unresolvedQuestions).not.toEqual([]);
  });
});

async function inspectionFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-brief-inspection-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(path.join(root, "src", "feature.ts"), [
    'import type { FeatureContract } from "./contract.js";',
    "export function applyFeature(input: FeatureContract): boolean {",
    "  return input.enabled;",
    "}"
  ].join("\n"));
  await writeFile(path.join(root, "src", "contract.ts"), "export interface FeatureContract { enabled: boolean }\n");
  await writeFile(path.join(root, "tests", "feature.test.ts"), "export const featureRegression = true;\n");
  await writeFile(path.join(root, "private", "unrelated.ts"), "export const credential = 'do-not-read';\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
  const phase = testPhase();
  const state = minimalState(root, phase);
  const config = defaultConfig();
  return { root, phase, state, config };
}

function testPhase(): WorkflowPhase {
  return {
    id: "phase-1",
    objective: "Make feature evaluation preserve the typed contract.",
    rationale: "The existing feature boundary needs a focused compatibility change.",
    dependencies: [],
    dependsOn: [],
    expectedReadAreas: ["src/feature.ts"],
    expectedWriteAreas: ["src/feature.ts"],
    expectedFilesOrAreas: ["src/feature.ts"],
    acceptanceCriteria: ["Feature evaluation returns the contract-defined result for enabled and disabled inputs."],
    validationCommands: ["npm test", "npm run typecheck"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "ready",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

function minimalState(root: string, phase: WorkflowPhase): SequentialWorkflowState {
  return {
    id: "lr-inspection-test",
    version: 2,
    revision: 4,
    root,
    request: "Update src/feature.ts without changing unrelated repository paths.",
    mode: "rigorous",
    state: "executing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    blockers: [],
    events: [],
    validation: [],
    repairAttempts: 0,
    phaseLeases: {},
    execution: { records: {} },
    plan: { version: 1, summary: "Bounded feature change.", principles: [], phases: [phase], revisionRequests: [] },
    approval: {
      policy: "phase-by-phase",
      workflowPlanRevision: 4,
      history: [],
      decisionHistory: []
    }
  };
}
