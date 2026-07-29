import type { ModelTier } from "../../config/schema.js";
import {
  PlanningProviderInvocationError,
  type PlanningProvider,
  type PlanningProviderInput,
  type PlanningProviderResult,
  type PlanningRepairRequest,
  type PlanningSemanticReview,
  type PlanningSemanticReviewResult
} from "../../core/planning-runner.js";
import type { ExecutionPlan } from "../../core/types.js";
import type { JsonSchema, StructuredDecisionProvider, StructuredDecisionRequest, StructuredDecisionResult } from "../../core/structured-decision.js";
import { TriageProviderError } from "../../core/triage-runner.js";
import { ClaudeCliStructuredDecisionProvider } from "./structured-decision-provider.js";
import type { CommandRunner } from "./triage-provider.js";
import { defaultCommandRunner } from "./triage-provider.js";

export class ClaudeCliPlanningProvider implements PlanningProvider {
  name = "claude-cli";
  private readonly decisions: StructuredDecisionProvider;

  constructor(runCommand: CommandRunner = defaultCommandRunner) {
    this.decisions = new ClaudeCliStructuredDecisionProvider(runCommand);
  }

  async plan(input: PlanningProviderInput): Promise<PlanningProviderResult> {
    const result = await this.decide({
      root: input.root,
      prompt: buildPlanningPrompt(input),
      schema: planningJsonSchema(input),
      tier: "small",
      config: input.config,
      stage: "planning draft",
      maxTurns: input.config.budgets.planningMaxTurns,
      effort: "low",
      tools: "none"
    });
    return {
      raw: result.value,
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      launchMode: result.launchMode,
      warnings: result.warnings
    };
  }

  async repair(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult> {
    const result = await this.decide({
      root: input.root,
      prompt: buildPlanningRepairPrompt(input, request),
      schema: planningJsonSchema(input),
      tier: request.tier ?? "small",
      config: input.config,
      stage: "planning repair",
      maxTurns: input.config.budgets.planningRepairMaxTurns,
      effort: "low",
      tools: "none"
    });
    return {
      raw: result.value,
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      launchMode: result.launchMode,
      warnings: result.warnings
    };
  }

  async escalate(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult> {
    const result = await this.decide({
      root: input.root,
      prompt: buildPlanningEscalationPrompt(input, request),
      schema: planningJsonSchema(input),
      tier: planningEscalationTier(input),
      config: input.config,
      stage: "planning architecture escalation",
      maxTurns: input.config.budgets.planningMaxTurns,
      effort: "medium",
      tools: "none"
    });
    return {
      raw: result.value,
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      launchMode: result.launchMode,
      warnings: result.warnings
    };
  }

  async review(input: PlanningProviderInput, request: { plan: ExecutionPlan }): Promise<PlanningSemanticReviewResult> {
    const result = await this.decide<PlanningSemanticReview>({
      root: input.root,
      prompt: buildPlanningSemanticReviewPrompt(request.plan),
      schema: planningSemanticReviewSchema(request.plan),
      tier: "small",
      config: input.config,
      stage: "planning semantic review",
      maxTurns: input.config.budgets.planningRepairMaxTurns,
      effort: "low",
      tools: "none"
    });
    return {
      raw: result.value,
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      launchMode: result.launchMode,
      warnings: result.warnings,
      review: result.value
    };
  }

  private async decide<T = unknown>(request: StructuredDecisionRequest): Promise<StructuredDecisionResult<T>> {
    try {
      return await this.decisions.decide<T>(request);
    } catch (error) {
      const kind = error instanceof TriageProviderError ? error.kind : "provider_process_failure";
      throw new PlanningProviderInvocationError(
        error instanceof Error ? error.message : String(error ?? "unknown planning provider failure"),
        kind,
        { provider: this.name, tier: request.tier, launchMode: "bare" }
      );
    }
  }
}

function planningEscalationTier(input: PlanningProviderInput): ModelTier {
  return input.triage.workflow.finalMode === "rigorous"
    ? input.config.routing.rigorousPlanning
    : input.config.routing.standardPlanning;
}

function candidateAreas(input: PlanningProviderInput): string[] {
  return [...new Set(input.deterministicPlan.phases.flatMap((phase) => [
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.expectedFilesOrAreas
  ]).map((area) => area.trim()).filter(Boolean))];
}

function planningJsonSchema(input: PlanningProviderInput): JsonSchema {
  const candidates = candidateAreas(input);
  const boundedArea = candidates.length > 0
    ? { type: "string", enum: candidates }
    : { type: "string", minLength: 1 };
  return {
    type: "object",
    properties: {
      version: { type: "number", const: 1 },
      summary: { type: "string", minLength: 12 },
      principles: { type: "array", items: { type: "string", minLength: 4 }, maxItems: 12 },
      phases: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^phase-[A-Za-z0-9._-]+$" },
            objective: { type: "string", minLength: 12 },
            rationale: { type: "string", minLength: 12 },
            dependencies: { type: "array", items: { type: "string", pattern: "^phase-[A-Za-z0-9._-]+$" }, uniqueItems: true },
            expectedReadAreas: { type: "array", items: boundedArea, uniqueItems: true },
            expectedWriteAreas: { type: "array", minItems: 1, items: boundedArea, uniqueItems: true },
            expectedFilesOrAreas: { type: "array", minItems: 1, items: boundedArea, uniqueItems: true },
            acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 12 } },
            validationCommands: { type: "array", minItems: 1, items: { type: "string", minLength: 2 }, uniqueItems: true },
            riskLevel: { type: "string", enum: ["low", "medium", "high"] },
            modelTier: { type: "string", enum: ["small", "medium", "large", "inherit"] }
          },
          required: ["id", "objective", "rationale", "dependencies", "expectedReadAreas", "expectedWriteAreas", "expectedFilesOrAreas", "acceptanceCriteria", "validationCommands", "riskLevel", "modelTier"],
          additionalProperties: false
        }
      },
      revisionRequests: { const: input.revisionRequests }
    },
    required: ["version", "summary", "principles", "phases", "revisionRequests"],
    additionalProperties: false
  };
}

function planningSemanticReviewSchema(plan: ExecutionPlan): JsonSchema {
  const phaseIds = plan.phases.map((phase) => phase.id);
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "needs-revision", "uncertain"] },
      issues: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            phaseId: { type: "string", enum: phaseIds },
            code: { type: "string", enum: ["acceptance.not_inspectable", "closure.future_dependency", "dependency.unlinked_producer"] },
            message: { type: "string", minLength: 12, maxLength: 600 },
            evidence: { type: "string", minLength: 8, maxLength: 600 },
            producerPhaseId: { type: "string", enum: phaseIds }
          },
          required: ["phaseId", "code", "message", "evidence"],
          additionalProperties: false
        }
      },
      summary: { type: "string", minLength: 8, maxLength: 600 }
    },
    required: ["verdict", "issues", "summary"],
    additionalProperties: false
  };
}

function buildPlanningPrompt(input: PlanningProviderInput): string {
  return [
    "You are the bounded sequential planning candidate generator for LeanRigor.",
    "Return only the JSON value required by the supplied schema.",
    "You have no repository tools. Use only the bounded evidence and candidate paths below.",
    "Never invent a path. Every read and write area must be selected from Candidate repository paths.",
    "LeanRigor will deterministically validate constraints, ownership, phase sizing, dependencies, and approval safety.",
    "Keep phases sequential, independently reviewable, and within one production-owner boundary unless the rationale explicitly establishes repository-state closure.",
    "Every acceptance criterion must describe observable evidence and every phase must include a validation command.",
    "Preserve revisionRequests exactly.",
    "User request:", input.request,
    "Bounded triage evidence:", JSON.stringify(input.triage, null, 2),
    "Authoritative approved constraint set:", JSON.stringify(input.effectiveConstraintSet ?? { finalEffective: input.effectiveConstraints ?? input.triage.constraints.mustNot }, null, 2),
    "Constraint change audit:", JSON.stringify(input.constraintChanges ?? [], null, 2),
    "Candidate repository paths:", JSON.stringify(candidateAreas(input), null, 2),
    "Deterministic baseline safety floor:", JSON.stringify(input.deterministicPlan, null, 2)
  ].join("\n\n");
}

function buildPlanningRepairPrompt(input: PlanningProviderInput, request: PlanningRepairRequest): string {
  return [
    "Repair the bounded LeanRigor Workflow Plan candidate using only the exact diagnostics supplied.",
    "Return only the JSON value required by the supplied schema.",
    "Do not invent paths or change valid fields. Preserve revisionRequests exactly.",
    "Candidate repository paths:", JSON.stringify(candidateAreas(input), null, 2),
    "Authoritative approved constraints:", JSON.stringify(input.effectiveConstraintSet ?? { finalEffective: input.effectiveConstraints ?? [] }, null, 2),
    "Diagnostics to repair:", JSON.stringify(request.diagnostics, null, 2),
    "Invalid plan:", JSON.stringify(request.plan, null, 2)
  ].join("\n\n");
}

function buildPlanningEscalationPrompt(input: PlanningProviderInput, request: PlanningRepairRequest): string {
  return [
    "Resolve only the remaining architectural or cross-phase diagnostics in this bounded LeanRigor Workflow Plan candidate.",
    "Return only the JSON value required by the supplied schema.",
    "Do not broaden scope, invent paths, reinterpret approved constraints, or change valid fields.",
    "Candidate repository paths:", JSON.stringify(candidateAreas(input), null, 2),
    "Authoritative approved constraints:", JSON.stringify(input.effectiveConstraintSet ?? { finalEffective: input.effectiveConstraints ?? [] }, null, 2),
    "Remaining diagnostics:", JSON.stringify(request.diagnostics, null, 2),
    "Plan requiring architectural repair:", JSON.stringify(request.plan, null, 2)
  ].join("\n\n");
}

function buildPlanningSemanticReviewPrompt(plan: ExecutionPlan): string {
  return [
    "You are a bounded semantic reviewer for a LeanRigor Workflow Plan.",
    "Return only the JSON value required by the supplied schema. You have no repository tools.",
    "Assess only these semantic questions: whether acceptance criteria have concrete observable evidence, and whether a phase truly requires an artifact that is produced only by another phase without declaring that dependency.",
    "Do not infer a dependency from shared vocabulary. Mentioning the same type, API, JSON format, file, or concept in two phases is not evidence that one phase produces it for the other.",
    "Report a future dependency only when the plan itself establishes both a concrete produced artifact and that the earlier phase requires that artifact before it exists.",
    "If the available plan text cannot establish that conclusion, return verdict 'uncertain' with no issues. Do not manufacture an issue from a word match.",
    "Use verdict 'needs-revision' only for concrete, evidenced issues. Otherwise return 'pass'.",
    "Workflow Plan:", JSON.stringify(plan, null, 2)
  ].join("\n\n");
}
