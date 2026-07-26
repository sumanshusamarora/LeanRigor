import type { LeanRigorConfig } from "../config/schema.js";
import type { ExecutionPlan, TriageOutput } from "./types.js";
import { normaliseModelPayload, type TriageProviderSelection } from "./triage-runner.js";

export interface PlanningProviderResult {
  raw: unknown;
  provider: string;
  model?: string;
  warnings?: string[];
}

export interface PlanningProviderInput {
  request: string;
  root: string;
  config: LeanRigorConfig;
  triage: TriageOutput;
  deterministicPlan: ExecutionPlan;
  revisionRequests: ExecutionPlan["revisionRequests"];
}

export interface PlanningProvider {
  name: string;
  plan(input: PlanningProviderInput): Promise<PlanningProviderResult>;
}

export interface PlanningRunResult {
  plan: ExecutionPlan;
  source: "model" | "deterministic-fallback";
  provider: string;
  model?: string;
  attempts: number;
  fallbackReason?: string;
  warnings: string[];
}

export async function runPlanning(args: {
  input: PlanningProviderInput;
  provider?: PlanningProvider;
  providerSelection?: TriageProviderSelection;
  validate: (raw: unknown) => ExecutionPlan;
}): Promise<PlanningRunResult> {
  const { input, provider } = args;
  const warnings: string[] = [];

  if (!input.config.workflow.automaticTriage || !provider) {
    const fallbackReason = !input.config.workflow.automaticTriage
      ? "automatic model planning is disabled by configuration"
      : args.providerSelection === "deterministic"
        ? "deterministic provider explicitly selected"
        : "no model planning provider was resolved";
    return {
      plan: input.deterministicPlan,
      source: "deterministic-fallback",
      provider: provider?.name ?? "deterministic",
      attempts: 0,
      fallbackReason,
      warnings
    };
  }

  const maxAttempts = Math.min(2, input.config.budgets.triageCalls);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await provider.plan(input);
      warnings.push(...(result.warnings ?? []));
      const plan = args.validate(normaliseModelPayload(result.raw));
      return {
        plan,
        source: "model",
        provider: result.provider,
        model: result.model,
        attempts: attempt,
        warnings
      };
    } catch (error) {
      warnings.push(`Model planning attempt ${attempt} failed: ${messageOf(error)}`);
    }
  }

  const fallbackReason = `model planning failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}`;
  warnings.push("Using deterministic planning fallback after model plan could not be validated.");
  return {
    plan: input.deterministicPlan,
    source: "deterministic-fallback",
    provider: provider.name,
    attempts: maxAttempts,
    fallbackReason,
    warnings
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
