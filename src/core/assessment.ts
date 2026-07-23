import type { LeanRigorConfig } from "../config/schema.js";
import type { TriageOutput, WorkflowMode } from "./types.js";
import { defaultReviewLevel, defaultTestLevel } from "./review-policy.js";
import { triageOutputSchema } from "./triage-schema.js";

const RIGOROUS_TRIGGERS = [
  "authenticated", "authentication", "authorization", "authorisation", "permission", "payment", "billing",
  "migration", "production", "production infrastructure", "secret", "credential", "encryption", "public api",
  "public contract", "breaking api", "data deletion", "delete data", "concurrency", "duplicate-processing",
  "distributed consistency", "privacy", "compliance"
];
const FAST_TERMS = ["copy", "typo", "spacing", "css", "documentation", "readme", "label", "text change"];
const BUG_TERMS = ["bug", "fix", "error", "regression", "broken", "fails", "failure"];
const INVESTIGATION_TERMS = ["investigate", "analysis", "root cause", "diagnose", "read-only"];
const PARALLEL_TERMS = ["backend and frontend", "multiple packages", "adapters", "independent", "in parallel"];

function includesAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function conciseSummary(request: string): string {
  const clean = request.trim().replace(/\s+/g, " ");
  return clean.length <= 220 ? clean : `${clean.slice(0, 217)}...`;
}

export function assessTask(request: string, config: LeanRigorConfig): TriageOutput {
  const text = request.toLowerCase();
  const authTrigger = /\bauth\b/.test(text) ? "auth" : undefined;
  const rigorousTrigger = authTrigger ?? RIGOROUS_TRIGGERS.find((term) => text.includes(term));
  const fastCandidate = includesAny(text, FAST_TERMS);
  const bug = includesAny(text, BUG_TERMS) && !(fastCandidate && includesAny(text, ["typo", "copy", "documentation", "readme"]));
  const investigation = includesAny(text, INVESTIGATION_TERMS);
  const publicApi = text.includes("public api") || text.includes("public contract") || text.includes("api contract") || text.includes("breaking api");
  const migration = text.includes("migration") || text.includes("schema change");
  const security = Boolean(authTrigger) || includesAny(text, ["authenticated", "authentication", "authorization", "authorisation", "permission", "secret", "credential", "encryption"]);
  const dataIntegrity = migration || includesAny(text, ["delete data", "data deletion", "financial calculation", "payment", "billing"]);
  const operational = includesAny(text, ["production", "deployment", "infrastructure"]);

  let modelRecommendation: WorkflowMode = "standard";
  const escalationReasons: string[] = [];

  if (rigorousTrigger) {
    modelRecommendation = "rigorous";
    escalationReasons.push(`Explicit high-risk trigger detected: ${rigorousTrigger}.`);
  } else if (fastCandidate && !bug && !publicApi && !migration && !security && !dataIntegrity) {
    modelRecommendation = "fast";
  } else if (bug) {
    escalationReasons.push("Behavioural bug fixes normally require targeted regression validation.");
  }

  const taskType: TriageOutput["task"]["type"] = investigation
    ? "investigation"
    : bug
      ? "bug"
      : fastCandidate
        ? "documentation"
        : "feature";

  const confidence = rigorousTrigger || fastCandidate || bug ? 0.86 : 0.72;
  const clarificationRequired = request.trim().length < 12;
  const parallelism = config.parallelism.enabled && includesAny(text, PARALLEL_TERMS) ? "candidate" : "sequential";

  const preliminary: TriageOutput = {
    version: 1,
    task: { type: taskType, summary: conciseSummary(request) },
    assessment: {
      complexity: rigorousTrigger ? "high" : fastCandidate ? "low" : "medium",
      ambiguity: clarificationRequired ? "high" : fastCandidate ? "low" : request.trim().length < 30 ? "medium" : "low",
      blastRadius: rigorousTrigger ? "high" : fastCandidate ? "low" : "medium",
      architecturalImpact: rigorousTrigger ? "high" : "low",
      securityRisk: security ? "high" : "none",
      dataIntegrityRisk: dataIntegrity ? "high" : "none",
      operationalRisk: operational ? "high" : "none"
    },
    workflow: {
      modelRecommendation,
      finalMode: modelRecommendation,
      confidence,
      parallelism,
      reviewLevel: defaultReviewLevel(modelRecommendation, parallelism === "candidate"),
      testLevel: defaultTestLevel(modelRecommendation, taskType),
      overridden: false,
      overrideReason: null
    },
    clarification: clarificationRequired
      ? {
          required: true,
          question: "What specific behaviour or outcome should change?",
          reason: "The request is too brief to determine scope and acceptance criteria safely."
        }
      : { required: false, question: null, reason: null },
    inspection: {
      required: taskType !== "documentation",
      targets: taskType === "bug"
        ? ["current failing behaviour", "nearest implementation boundary", "existing regression tests"]
        : taskType === "documentation"
          ? ["requested document or copy location"]
          : ["relevant implementation boundary", "existing patterns", "nearby tests"]
    },
    escalationReasons: escalationReasons.slice(0, config.triage.maxEscalationReasons),
    assumptions: clarificationRequired ? [] : ["The request is limited to the described repository change."],
    constraints: {
      mustNot: ["modify unrelated behaviour", "commit, push, deploy, or write to production without explicit approval"]
    }
  };

  return applyPolicyOverrides(preliminary, config);
}

export function applyPolicyOverrides(input: TriageOutput, config: LeanRigorConfig): TriageOutput {
  const output = structuredClone(input);
  const highRisk = output.assessment.securityRisk === "high"
    || output.assessment.dataIntegrityRisk === "high"
    || output.assessment.operationalRisk === "high";

  let finalMode: WorkflowMode = output.workflow.modelRecommendation;
  let overrideReason: string | null = null;

  if (config.workflow.defaultMode !== "adaptive") {
    finalMode = config.workflow.defaultMode as WorkflowMode;
    overrideReason = `Repository configuration forces ${finalMode} mode.`;
  } else if (highRisk && finalMode !== "rigorous") {
    finalMode = "rigorous";
    overrideReason = "Deterministic policy escalated a high-risk task to rigorous mode.";
  } else if (finalMode === "fast") {
    const fastAllowed = output.assessment.ambiguity === "low"
      && output.assessment.blastRadius === "low"
      && output.assessment.securityRisk === "none"
      && output.assessment.dataIntegrityRisk === "none"
      && output.assessment.operationalRisk === "none"
      && output.assessment.architecturalImpact === "low";
    if (config.triage.fastRequiresPositiveEvidence && !fastAllowed) {
      finalMode = "standard";
      overrideReason = "Fast mode requires positive evidence of low ambiguity, low blast radius, and no material risk.";
    }
  }

  output.workflow.finalMode = finalMode;
  output.workflow.overridden = finalMode !== output.workflow.modelRecommendation;
  output.workflow.overrideReason = output.workflow.overridden ? overrideReason : null;
  output.workflow.reviewLevel = highRisk
    ? config.review.highRiskPaths
    : finalMode === "fast"
      ? config.review.fast
      : finalMode === "standard"
        ? config.review.standard
        : config.review.rigorous;
  output.workflow.testLevel = defaultTestLevel(finalMode, output.task.type);

  return validateTriageOutput(output);
}

export function validateTriageOutput(value: unknown): TriageOutput {
  return triageOutputSchema.parse(value) as TriageOutput;
}

export function fallbackTriage(request: string, config: LeanRigorConfig, reason: string): TriageOutput {
  const fallbackMode = config.triage.fallbackMode;
  return validateTriageOutput({
    version: 1,
    task: { type: "unknown", summary: conciseSummary(request) },
    assessment: {
      complexity: "medium", ambiguity: "high", blastRadius: "medium", architecturalImpact: "medium",
      securityRisk: "none", dataIntegrityRisk: "none", operationalRisk: "none"
    },
    workflow: {
      modelRecommendation: fallbackMode,
      finalMode: fallbackMode,
      confidence: 0,
      parallelism: "sequential",
      reviewLevel: config.review.standard,
      testLevel: "targeted",
      overridden: false,
      overrideReason: null
    },
    clarification: {
      required: true,
      question: "What behaviour should change, and what would count as complete?",
      reason: "Triage output could not be validated, so one blocking clarification is required."
    },
    inspection: { required: true, targets: ["relevant implementation boundary", "nearby tests"] },
    escalationReasons: [`Triage fallback used: ${reason}`],
    assumptions: [],
    constraints: { mustNot: ["modify files until the blocking clarification is resolved"] }
  });
}
