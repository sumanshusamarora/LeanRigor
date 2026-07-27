import type { ClarificationDecision, ClarificationOwnership, ModelTriageRecommendation, TriageEvidencePacket, TriageQuestion, WorkflowMode } from "./types.js";

export interface ClarificationEvaluationInput {
  request: string;
  evidence: TriageEvidencePacket;
  recommendation: ModelTriageRecommendation;
  finalMode: WorkflowMode;
}

export function evaluateClarification(input: ClarificationEvaluationInput): ClarificationDecision {
  const original = input.recommendation.clarification ?? {
    required: input.request.trim().length < 12,
    question: input.request.trim().length < 12 ? "What specific behaviour or outcome should change?" : null,
    reason: input.request.trim().length < 12 ? "The request is too brief to determine scope and acceptance criteria safely." : null
  };

  if (!original.required) {
    return {
      original,
      ownership: "unnecessary",
      disposition: "suppressed",
      finalRequired: false,
      reason: "No blocking clarification was requested."
    };
  }

  const ownership = classifyClarificationOwnership(original.question ?? "", original.reason ?? "", input.evidence);
  const blocking = ownership === "user-intent" || ownership === "user-policy" || ownership === "safety-critical";
  const disposition = blocking ? "accepted" : ownership === "repository-discoverable" ? "deferred" : "suppressed";
  const reason = decisionReason(ownership, input.finalMode);

  return {
    original,
    ownership,
    disposition,
    finalRequired: blocking,
    reason
  };
}

export function classifyClarificationOwnership(question: string, reason: string, evidence: TriageEvidencePacket): ClarificationOwnership {
  const text = `${question} ${reason}`.toLowerCase();
  const resolvedWorkItem = evidence.referencedWorkItems?.some((item) => item.contentStatus === "resolved") ?? false;
  const hasAcceptanceCriteria = evidence.referencedWorkItems?.some((item) => (item.acceptanceCriteria?.length ?? 0) > 0) ?? false;

  if (!question.trim()) return "unnecessary";
  if (resolvedWorkItem && hasAcceptanceCriteria && mentionsIssueScope(text, evidence)) return "already-resolved";
  if (isPlanningDetailQuestion(text)) return "planning-detail";
  if (isRepositoryScopeQuestion(text)) return "repository-discoverable";
  if (isSafetyCriticalQuestion(text)) return "safety-critical";
  if (isUserPolicyQuestion(text)) return "user-policy";
  if (isUserIntentQuestion(text)) return "user-intent";
  if (resolvedWorkItem && /sparse specification|scope|subsystems|affected/.test(text)) return "already-resolved";
  return "planning-detail";
}

export function clarificationInspectionQuestions(evidence: TriageEvidencePacket, recommendation: ModelTriageRecommendation): TriageQuestion[] {
  const clarification = recommendation.clarification;
  if (!clarification?.required || !clarification.question) return [];
  const ownership = classifyClarificationOwnership(clarification.question, clarification.reason ?? "", evidence);
  if (ownership !== "repository-discoverable") return [];
  return deriveRepositoryQuestions(evidence, clarification.question);
}

function deriveRepositoryQuestions(evidence: TriageEvidencePacket, originalQuestion: string): TriageQuestion[] {
  const concepts = evidence.changeSignals.namedBoundaries.length > 0
    ? evidence.changeSignals.namedBoundaries
    : ["workflow", "planning", "validation", "tests"];
  return concepts.slice(0, 4).map((concept, index) => ({
    id: `clarification-scope-${index + 1}`,
    question: `Identify the existing implementation boundary for ${concept}.`,
    reason: `Repository-owned scope question deferred from model clarification: ${originalQuestion}`
  }));
}

function mentionsIssueScope(text: string, evidence: TriageEvidencePacket): boolean {
  const issueNumbers = evidence.referencedWorkItems?.map((item) => item.issueNumber) ?? [];
  return /scope|subsystems|affected|specific/.test(text) && issueNumbers.some((number) => text.includes(`#${number}`) || text.includes(`issue ${number}`));
}

function isRepositoryScopeQuestion(text: string): boolean {
  return /\b(which|what|where)\b.*\b(files?|subsystems?|codebase|components?|implementation|schema|tests?|gate|workflow|planner|planning|evidence)\b/.test(text)
    || /\baffected subsystems?\b/.test(text)
    || /\bwhere is\b.*\bdefined\b/.test(text);
}

function isPlanningDetailQuestion(text: string): boolean {
  return /\b(exact|specific)\b.*\b(files?|phase|order|symbols?|implementation steps?)\b/.test(text)
    || /\bphase decomposition\b/.test(text)
    || /\bimplementation order\b/.test(text);
}

function isSafetyCriticalQuestion(text: string): boolean {
  return /\b(data loss|delete data|destructive|irreversible|drop table|truncate|production data)\b/.test(text)
    || /\b(public api|public contract|breaking api|break compatibility|breaking change)\b.*\b(acceptable|allowed|intended|intentional|should|may)\b/.test(text);
}

function isUserPolicyQuestion(text: string): boolean {
  return /\b(production|development only|deploy|public contract|compatibility|migration)\b.*\b(acceptable|allowed|required|waive|permit|policy)\b/.test(text);
}

function isUserIntentQuestion(text: string): boolean {
  return /\b(which|choose|prefer)\b.*\b(behaviou?r|option|outcome|semantics)\b/.test(text)
    || /\bwhat specific behaviou?r or outcome should change\b/.test(text);
}

function decisionReason(ownership: ClarificationOwnership, finalMode: WorkflowMode): string {
  switch (ownership) {
    case "user-intent":
      return "The question asks for missing user intent that LeanRigor cannot infer safely.";
    case "user-policy":
      return "The question asks for a user-owned policy decision.";
    case "safety-critical":
      return "The question asks for safety-critical permission that must be explicit.";
    case "repository-discoverable":
      return `Repository scope is discoverable by bounded inspection or planning; ${finalMode} mode can proceed without asking the user.`;
    case "planning-detail":
      return `The question belongs to planning, not triage; ${finalMode} mode can proceed with plan approval as the next control point.`;
    case "already-resolved":
      return "The referenced work item already supplies enough issue context for triage.";
    case "unnecessary":
      return "No blocking clarification is needed.";
  }
}
