import type { LeanRigorConfig, ModelTier } from "../config/schema.js";

export type JsonSchema = Record<string, unknown>;

export interface StructuredDecisionCapabilities {
  structuredOutput: boolean;
  schemaEnforcement: boolean;
  minimalContext: boolean;
  toolIsolation: boolean;
}

export interface StructuredDecisionRequest {
  root: string;
  prompt: string;
  schema: JsonSchema;
  tier: ModelTier;
  config: LeanRigorConfig;
  stage: string;
  maxTurns: number;
  effort?: "low" | "medium" | "high";
  tools: "none" | "read-only";
}

export interface StructuredDecisionResult<T = unknown> {
  value: T;
  provider: string;
  model?: string;
  tier: ModelTier;
  launchMode: string;
  warnings: string[];
}

/** Provider-neutral bounded model assistance; callers retain policy authority. */
export interface StructuredDecisionProvider {
  readonly name: string;
  capabilities(): StructuredDecisionCapabilities;
  decide<T = unknown>(request: StructuredDecisionRequest): Promise<StructuredDecisionResult<T>>;
}
