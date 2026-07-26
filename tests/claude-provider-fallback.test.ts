import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliPlanningProvider } from "../src/adapters/claude/planning-provider.js";
import { ClaudeCliTriageProvider, type CommandRunner } from "../src/adapters/claude/triage-provider.js";
import { defaultConfig } from "../src/config/defaults.js";
import { assessTask } from "../src/core/assessment.js";
import type { PlanningProviderInput } from "../src/core/planning-runner.js";
import type { ExecutionPlan } from "../src/core/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function commandRunner(args: {
  failModels: string[];
  failureReason?: string;
  output: unknown;
  calls: string[][];
}): CommandRunner {
  return async (_command, commandArgs) => {
    args.calls.push(commandArgs);
    const modelIndex = commandArgs.indexOf("--model");
    const model = modelIndex >= 0 ? commandArgs[modelIndex + 1] : undefined;
    if (model && args.failModels.includes(model)) {
      return { stdout: "", stderr: args.failureReason ?? `model ${model} unavailable`, exitCode: 1 };
    }
    return { stdout: JSON.stringify({ result: JSON.stringify(args.output) }), stderr: "", exitCode: 0 };
  };
}

describe("Claude provider model tier fallback", () => {
  it("tries triage fallback tiers before deterministic triage can run", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliTriageProvider(commandRunner({
      failModels: ["haiku"],
      output: assessTask("Fix the broken assignment API regression", config),
      calls
    }));

    const result = await provider.classify("Fix the broken assignment API regression", process.cwd(), config);

    expect(modelArgs(calls)).toEqual(["haiku", "sonnet"]);
    expect(result.model).toBe("sonnet");
    expect(result.warnings?.join("\n")).toContain("triage tier 'small'");
  });

  it("tries planning fallback tiers down to inherited Claude default", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: ["sonnet", "opus"],
      output: compactPlan(),
      calls
    }));

    const result = await provider.plan(planningInput(config));

    expect(modelArgs(calls)).toEqual(["sonnet", "opus", "inherit"]);
    expect(result.model).toBeUndefined();
    expect(result.warnings?.join("\n")).toContain("planning tier 'medium'");
    expect(result.warnings?.join("\n")).toContain("planning tier 'large'");
  });

  it("uses ANTHROPIC_DEFAULT_SONNET_MODEL for standard planning when no LeanRigor model is configured", async () => {
    clearModelEnv();
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-env-sonnet");
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: [],
      output: compactPlan(),
      calls
    }));

    const result = await provider.plan(planningInput(config));

    expect(modelArgs(calls)).toEqual(["deepseek-env-sonnet"]);
    expect(result.model).toBe("deepseek-env-sonnet");
  });

  it("surfaces max-turn provider fallback diagnostics explicitly", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: ["sonnet"],
      failureReason: "Claude stopped because maximum turns were reached",
      output: compactPlan(),
      calls
    }));

    const result = await provider.plan(planningInput(config));

    expect(modelArgs(calls)).toEqual(["sonnet", "opus"]);
    expect(result.warnings?.join("\n")).toContain("max_turns_reached");
  });
});

function clearModelEnv(): void {
  for (const key of [
    "LEANRIGOR_CLAUDE_MODEL_SMALL",
    "LEANRIGOR_CLAUDE_MODEL_MEDIUM",
    "LEANRIGOR_CLAUDE_MODEL_LARGE",
    "LEANRIGOR_MODEL_SMALL",
    "LEANRIGOR_MODEL_MEDIUM",
    "LEANRIGOR_MODEL_LARGE",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL"
  ]) {
    vi.stubEnv(key, "");
  }
}

function modelArgs(calls: string[][]): string[] {
  return calls.map((args) => {
    const index = args.indexOf("--model");
    return index >= 0 ? args[index + 1] ?? "" : "inherit";
  });
}

function planningInput(config = defaultConfig()): PlanningProviderInput {
  const deterministicPlan: ExecutionPlan = {
    version: 1,
    summary: "Deterministic baseline.",
    principles: [],
    phases: [{
      id: "phase-1",
      objective: "Implement primary behavior.",
      rationale: "Baseline phase.",
      dependencies: [],
      dependsOn: [],
      expectedReadAreas: [],
      expectedWriteAreas: [],
      expectedFilesOrAreas: [],
      acceptanceCriteria: ["Behavior is implemented."],
      validationCommands: ["npm test"],
      riskLevel: "medium",
      modelTier: "medium",
      status: "planned",
      filesChanged: [],
      commandsRun: [],
      validationResults: [],
      repairAttempts: [],
      scopeDeviations: []
    }],
    revisionRequests: []
  };
  return {
    request: "Fix the broken assignment API regression",
    root: process.cwd(),
    config,
    triage: assessTask("Fix the broken assignment API regression", config),
    deterministicPlan,
    revisionRequests: []
  };
}

function compactPlan(): unknown {
  return {
    version: 1,
    summary: "Model plan.",
    principles: ["Use repository-specific evidence."],
    phases: [{
      id: "phase-1",
      objective: "Implement issue-specific behavior.",
      rationale: "Model selected this boundary.",
      dependencies: [],
      expectedReadAreas: ["src/core/flow.ts"],
      expectedWriteAreas: ["src/core/flow.ts"],
      expectedFilesOrAreas: ["src/core/flow.ts"],
      acceptanceCriteria: ["Behavior is covered by focused evidence."],
      validationCommands: ["npm test"],
      riskLevel: "medium",
      modelTier: "medium"
    }],
    revisionRequests: []
  };
}
