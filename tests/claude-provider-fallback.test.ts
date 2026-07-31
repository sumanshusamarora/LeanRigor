import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliPlanningProvider } from "../src/adapters/claude/planning-provider.js";
import { buildTriagePrompt, ClaudeCliTriageProvider, defaultCommandRunner, runClaudeWithTierFallback, type CommandRunner } from "../src/adapters/claude/triage-provider.js";
import { defaultConfig } from "../src/config/defaults.js";
import { assessTask } from "../src/core/assessment.js";
import { PlanningValidationError, runPlanning, type PlanningProviderInput } from "../src/core/planning-runner.js";
import { collectTriageEvidence } from "../src/core/triage-evidence.js";
import type { ExecutionPlan, ModelTriageRecommendation } from "../src/core/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function commandRunner(args: {
  failModels: string[];
  failureReason?: string;
  output: unknown;
  calls: string[][];
}): CommandRunner {
  return async (_command, commandArgs, _cwd, prompt) => {
    args.calls.push(commandArgs);
    expect(prompt).toEqual(expect.any(String));
    expect(commandArgs[commandArgs.indexOf("-p") + 1]).not.toContain("bounded sequential");
    const modelIndex = commandArgs.indexOf("--model");
    const model = modelIndex >= 0 ? commandArgs[modelIndex + 1] : undefined;
    if (model && args.failModels.includes(model)) {
      return { stdout: "", stderr: args.failureReason ?? `model ${model} unavailable`, exitCode: 1 };
    }
    return { stdout: JSON.stringify({ result: JSON.stringify(args.output) }), stderr: "", exitCode: 0 };
  };
}

describe("Claude provider model tier fallback", () => {
  it("streams a prompt from a temporary file rather than a command-line argument", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "leanrigor-prompt-transport-"));
    const script = path.join(root, "read-prompt.js");
    await writeFile(script, "process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(input));", "utf8");
    const prompt = `large prompt ${"x".repeat(40_000)}`;

    const result = await defaultCommandRunner(process.execPath, [script], root, prompt);

    expect(result).toMatchObject({ stdout: prompt, stderr: "", exitCode: 0 });
  });

  it("tries triage fallback tiers before deterministic triage can run", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliTriageProvider(commandRunner({
      failModels: ["haiku"],
      output: recommendation(),
      calls
    }));

    const result = await provider.recommend({
      request: "Fix the broken assignment API regression",
      root: process.cwd(),
      config,
      evidence: await collectTriageEvidence({ request: "Fix the broken assignment API regression", root: process.cwd(), config })
    });

    expect(modelArgs(calls)).toEqual(["haiku", "sonnet"]);
    expect(result.model).toBe("sonnet");
    expect(result.warnings?.join("\n")).toContain("triage recommendation tier 'small'");
  });

  it("runs normal triage recommendation without repository tools", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliTriageProvider(commandRunner({
      failModels: [],
      output: recommendation(),
      calls
    }));

    await provider.recommend({
      request: "Fix typo in README",
      root: process.cwd(),
      config,
      evidence: await collectTriageEvidence({ request: "Fix typo in README", root: process.cwd(), config })
    });

    const args = calls[0] ?? [];
    expect(args).toContain("--bare");
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("2");
    expect(args.join(" ")).toContain("Read,Glob,Grep,Bash");
    expect(args).not.toContain("--allowedTools");
  });

  it("prefers plugin-owned triage prompt assets over target repository sources", async () => {
    const config = defaultConfig();
    const root = await mkdtemp(path.join(os.tmpdir(), "leanrigor-target-"));
    const pluginRoot = await mkdtemp(path.join(os.tmpdir(), "leanrigor-plugin-"));
    await mkdir(path.join(root, "internal-skills", "triage-task"), { recursive: true });
    await mkdir(path.join(pluginRoot, "internal-skills", "triage-task"), { recursive: true });
    await writeFile(path.join(root, "internal-skills", "triage-task", "SKILL.md"), "TARGET_REPO_SKILL", "utf8");
    await writeFile(path.join(pluginRoot, "internal-skills", "triage-task", "SKILL.md"), "PLUGIN_OWNED_SKILL", "utf8");
    vi.stubEnv("CLAUDE_PLUGIN_ROOT", pluginRoot);

    const prompt = await buildTriagePrompt({
      request: "Fix typo in README",
      root,
      config,
      evidence: await collectTriageEvidence({ request: "Fix typo in README", root, config })
    });

    expect(prompt).toContain("PLUGIN_OWNED_SKILL");
    expect(prompt).not.toContain("TARGET_REPO_SKILL");
  });

  it("starts Standard planning on its configured tier and falls back through configured tiers", async () => {
    clearModelEnv();
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: ["haiku", "sonnet", "opus"],
      output: compactPlan(),
      calls
    }));

    const result = await provider.plan(planningInput(config));

    expect(modelArgs(calls)).toEqual(["sonnet", "opus", "inherit"]);
    expect(result.model).toBeUndefined();
    expect(result.warnings?.join("\n")).toContain("planning draft tier 'medium'");
    expect(result.warnings?.join("\n")).toContain("planning draft tier 'large'");
  });

  it("uses ANTHROPIC_DEFAULT_SONNET_MODEL for the Standard structured planning draft", async () => {
    clearModelEnv();
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-env-medium");
    const config = defaultConfig();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: [],
      output: compactPlan(),
      calls
    }));

    const result = await provider.plan(planningInput(config));

    expect(modelArgs(calls)).toEqual(["deepseek-env-medium"]);
    expect(result.model).toBe("deepseek-env-medium");
  });

  it("uses the configured large tier for initial Rigorous planning and review", async () => {
    clearModelEnv();
    const calls: string[][] = [];
    const input = planningInput();
    input.triage.workflow.finalMode = "rigorous";
    const provider = new ClaudeCliPlanningProvider(commandRunner({ failModels: [], output: compactPlan(), calls }));

    const result = await provider.plan(input);

    expect(modelArgs(calls)).toEqual(["opus"]);
    expect(result.tier).toBe("large");
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

  it("surfaces Claude JSON error envelopes written to stdout", async () => {
    clearModelEnv();
    const config = defaultConfig();

    await expect(runClaudeWithTierFallback({
      runCommand: async () => ({
        stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
        stderr: "",
        exitCode: 1
      }),
      root: process.cwd(),
      baseArgs: ["-p"],
      prompt: "Return JSON.",
      preferredTier: "large",
      config,
      stage: "phase brief generation"
    })).rejects.toThrow("Not logged in · Please run /login");
  });

  it("uses bare schema-constrained minimal mode with no tools for planning", async () => {
    clearModelEnv();
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({ failModels: [], output: compactPlan(), calls }));

    const result = await provider.plan(planningInput());

    const args = calls[0] ?? [];
    expect(args).toContain("--bare");
    expect(args).toContain("--json-schema");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "{}")).toMatchObject({ type: "object", additionalProperties: false });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(result.launchMode).toBe("bare");
    expect(result.tier).toBe("medium");
  });

  it("uses configured planning and repair turn budgets", async () => {
    clearModelEnv();
    const config = defaultConfig();
    config.budgets.planningMaxTurns = 11;
    config.budgets.planningRepairMaxTurns = 6;
    const calls: string[][] = [];
    const provider = new ClaudeCliPlanningProvider(commandRunner({
      failModels: [],
      output: compactPlan(),
      calls
    }));

    await provider.plan(planningInput(config));
    await provider.repair(planningInput(config), { plan: compactPlan(), diagnostics: [], tier: "medium" });
    await provider.review(planningInput(config), { plan: planningInput(config).deterministicPlan });

    expect(calls[0]?.[calls[0].indexOf("--max-turns") + 1]).toBe("11");
    expect(calls[1]?.[calls[1].indexOf("--max-turns") + 1]).toBe("6");
    expect(calls[2]?.[calls[2].indexOf("--max-turns") + 1]).toBe("6");
    expect(calls[2]).toContain("--bare");
  });

  it("uses a bounded semantic review rather than lexical dependency inference", async () => {
    const input = planningInput();
    const stages: string[] = [];
    let reviewed = 0;
    const result = await runPlanning({
      input,
      provider: {
        name: "bounded-planner",
        async plan() {
          stages.push("draft");
          return { raw: { valid: true }, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare" };
        },
        async review() {
          stages.push("review");
          reviewed += 1;
          return {
            raw: {}, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare",
            review: reviewed === 1
              ? {
                  verdict: "needs-revision",
                  issues: [{
                    phaseId: "phase-1",
                    code: "closure.future_dependency",
                    message: "The phase requires a persisted contract that the later phase creates.",
                    evidence: "Phase 1 requires ContractV2; phase 2 explicitly creates ContractV2."
                  }]
                }
              : { verdict: "pass", issues: [] }
          };
        },
        async repair() {
          stages.push("repair");
          return { raw: { valid: true }, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare" };
        }
      },
      validate(raw) {
        if ((raw as { valid?: boolean }).valid) return input.deterministicPlan;
        throw new PlanningValidationError([{ stage: "schema", path: [], code: "invalid", message: "Invalid candidate." }]);
      }
    });

    expect(stages).toEqual(["draft", "review", "repair", "review"]);
    expect(result.source).toBe("model");
    expect(result.attemptRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "semantic-review", validation: "failed", diagnosticCodes: ["closure.future_dependency"] }),
      expect.objectContaining({ stage: "semantic-review", validation: "passed" })
    ]));
  });

  it("accepts an inconclusive semantic review instead of manufacturing a rejection", async () => {
    const input = planningInput();
    const result = await runPlanning({
      input,
      provider: {
        name: "bounded-planner",
        async plan() {
          return { raw: { valid: true }, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare" };
        },
        async review() {
          return {
            raw: {}, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare",
            review: { verdict: "uncertain", issues: [] }
          };
        }
      },
      validate() { return input.deterministicPlan; }
    });

    expect(result.source).toBe("model");
    expect(result.warnings.join("\n")).toContain("semantic review was inconclusive");
  });

  it("escalates only unresolved architectural diagnostics after a small repair", async () => {
    const input = planningInput();
    const stages: string[] = [];
    const result = await runPlanning({
      input,
      provider: {
        name: "bounded-planner",
        async plan() {
          stages.push("draft");
          return { raw: { valid: false }, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare" };
        },
        async repair() {
          stages.push("repair");
          return { raw: { valid: false }, provider: "bounded-planner", tier: "small", model: "small-model", launchMode: "bare" };
        },
        async escalate() {
          stages.push("escalation");
          return { raw: { valid: true }, provider: "bounded-planner", tier: "medium", model: "medium-model", launchMode: "bare" };
        }
      },
      providerSelection: "auto",
      validate(raw) {
        if ((raw as { valid?: boolean }).valid) return input.deterministicPlan;
        throw new PlanningValidationError([{
          stage: "quality",
          path: ["phases", 0, "expectedWriteAreas"],
          code: "scope.mixed_architectural_boundaries",
          message: "The phase mixes architectural boundaries."
        }]);
      }
    });

    expect(stages).toEqual(["draft", "repair", "escalation"]);
    expect(result.source).toBe("model");
    expect(result.model).toBe("medium-model");
    expect(result.attemptRecords).toMatchObject([
      { stage: "draft", tier: "small", invocation: "succeeded", validation: "failed" },
      { stage: "repair", tier: "small", invocation: "succeeded", validation: "failed" },
      { stage: "escalation", tier: "medium", invocation: "succeeded", validation: "passed" }
    ]);
  });
});

function recommendation(): ModelTriageRecommendation {
  return {
    version: 1,
    complexity: "medium",
    ambiguity: "low",
    blastRadius: "medium",
    risks: {
      architecturalImpact: "low",
      securityRisk: "none",
      dataIntegrityRisk: "none",
      operationalRisk: "none"
    },
    recommendedMode: "standard",
    confidence: 0.8,
    parallelism: "sequential",
    constraints: [],
    approachSummary: "Implement the requested change.",
    needsAdditionalInspection: false,
    inspectionQuestions: [],
    evidenceReferences: [],
    taskType: "feature",
    clarification: { required: false, question: null, reason: null }
  };
}

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
