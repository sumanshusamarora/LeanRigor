import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
export interface ModelResolver { resolve(tier: ModelTier, config: LeanRigorConfig): string | undefined; }
export interface HarnessAdapter { name: string; modelResolver: ModelResolver; install(root: string, config: LeanRigorConfig): Promise<void>; doctor(root: string, config: LeanRigorConfig): Promise<string[]>; }
