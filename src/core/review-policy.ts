import type { LeanRigorConfig } from "../config/schema.js";
import type { ReviewLevel, TestLevel, TriageOutput, WorkflowMode } from "./types.js";

export function defaultReviewLevel(mode: WorkflowMode, multiAgent = false): ReviewLevel {
  if (mode === "rigorous") return "deep";
  if (mode === "standard" || multiAgent) return "integrated";
  return "sanity";
}

export function defaultTestLevel(mode: WorkflowMode, taskType: TriageOutput["task"]["type"]): TestLevel {
  if (taskType === "documentation") return "sanity";
  if (taskType === "bug") return mode === "rigorous" ? "package" : "targeted";
  if (mode === "rigorous") return "package";
  if (mode === "standard") return "targeted";
  return "sanity";
}

export function shouldTriggerDeepReflection(args: {
  trigger: "scope-expansion" | "architecture-change" | "failed-repair" | "integration-conflict";
  failedRepairCount?: number;
  config: LeanRigorConfig;
}): boolean {
  const { trigger, failedRepairCount = 0, config } = args;
  if (trigger === "scope-expansion") return config.introspection.triggerOnScopeExpansion;
  if (trigger === "architecture-change") return config.introspection.triggerOnArchitectureChange;
  if (trigger === "integration-conflict") return true;
  return failedRepairCount >= config.introspection.triggerAfterFailedRepairs;
}
