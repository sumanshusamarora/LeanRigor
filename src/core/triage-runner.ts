import type { LeanRigorConfig } from "../config/schema.js";
import type { TriageOutput } from "./types.js";
import { applyPolicyOverrides, assessTask, validateTriageOutput } from "./assessment.js";

export interface TriageProviderResult {
  raw: unknown;
  provider: string;
  model?: string;
}

export interface TriageProvider {
  name: string;
  classify(request: string, root: string, config: LeanRigorConfig): Promise<TriageProviderResult>;
}

export interface TriageRunResult {
  output: TriageOutput;
  source: "model" | "deterministic-fallback";
  provider: string;
  model?: string;
  attempts: number;
  warnings: string[];
}

export class TriageExecutionError extends Error {}

/**
 * Runs model triage with one schema-correction retry, then falls back to the
 * deterministic classifier. Policy overrides are always applied after model
 * output validation, so the model is advisory rather than authoritative.
 */
export async function runTriage(args: {
  request: string;
  root: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
}): Promise<TriageRunResult> {
  const { request, root, config, provider } = args;
  const warnings: string[] = [];

  if (!config.workflow.automaticTriage || !provider) {
    return {
      output: assessTask(request, config),
      source: "deterministic-fallback",
      provider: provider?.name ?? "deterministic",
      attempts: 0,
      warnings
    };
  }

  const maxAttempts = Math.min(2, config.budgets.triageCalls);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await provider.classify(request, root, config);
      const parsed = validateTriageOutput(normaliseModelPayload(result.raw));
      const policyChecked = applyPolicyOverrides(parsed, config);
      return {
        output: policyChecked,
        source: "model",
        provider: result.provider,
        model: result.model,
        attempts: attempt,
        warnings
      };
    } catch (error) {
      warnings.push(`Model triage attempt ${attempt} failed: ${messageOf(error)}`);
    }
  }

  warnings.push("Using deterministic triage fallback after model output could not be validated.");
  return {
    output: assessTask(request, config),
    source: "deterministic-fallback",
    provider: provider.name,
    attempts: maxAttempts,
    warnings
  };
}

/** Accept direct JSON, fenced JSON, or Claude Code's JSON result envelope. */
export function normaliseModelPayload(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.result === "string") return parseJsonText(record.result);
    if (typeof record.content === "string") return parseJsonText(record.content);
    return raw;
  }
  if (typeof raw === "string") return parseJsonText(raw);
  throw new TriageExecutionError("Triage provider returned neither JSON nor text.");
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new TriageExecutionError("Model response did not contain valid JSON.");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
