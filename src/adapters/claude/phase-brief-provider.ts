import type {
  PhaseBriefPlanningInput,
  PhaseBriefPlanningProvider,
  PhaseBriefPlanningResult,
  PhaseBriefProposal,
  PhaseBriefRepairRequest
} from "../../core/phase-brief-planner.js";
import {
  supportingTestWriteAreas,
  synthesizeObservableAcceptanceCriteria
} from "../../core/phase-brief-planner.js";
import type { JsonSchema, StructuredDecisionProvider, StructuredDecisionRequest, StructuredDecisionResult } from "../../core/structured-decision.js";
import { ClaudeCliStructuredDecisionProvider } from "./structured-decision-provider.js";
import type { CommandRunner } from "./triage-provider.js";
import { defaultCommandRunner } from "./triage-provider.js";

/**
 * Produces the semantic portion of a Phase Execution Brief from already-bounded
 * repository evidence. Scope, provenance, and approval enforcement remain in
 * core and are never delegated to the model.
 */
export class ClaudeCliPhaseBriefPlanningProvider implements PhaseBriefPlanningProvider {
  readonly name = "claude-cli";
  private readonly decisions: StructuredDecisionProvider;

  constructor(runCommand: CommandRunner = defaultCommandRunner) {
    this.decisions = new ClaudeCliStructuredDecisionProvider(runCommand);
  }

  async generate(input: PhaseBriefPlanningInput): Promise<PhaseBriefPlanningResult> {
    return this.propose(input, "phase brief generation", buildGenerationPrompt(input));
  }

  async repair(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): Promise<PhaseBriefPlanningResult> {
    return this.propose(input, "phase brief repair", buildRepairPrompt(input, request));
  }

  async alternate(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): Promise<PhaseBriefPlanningResult> {
    return this.propose(input, "phase brief alternate strategy", buildAlternatePrompt(input, request));
  }

  private async propose(input: PhaseBriefPlanningInput, stage: string, prompt: string): Promise<PhaseBriefPlanningResult> {
    const result = await this.decide<PhaseBriefProposal>({
      root: input.state.root,
      prompt,
      schema: phaseBriefProposalSchema(input),
      tier: input.phase.modelTier,
      config: input.config,
      stage,
      maxTurns: input.config.budgets.planningRepairMaxTurns,
      effort: "medium",
      tools: "none"
    });
    return {
      proposal: result.value,
      provider: result.provider,
      modelTier: result.tier,
      warnings: [
        ...result.warnings,
        `Claude generated this Phase Execution Brief using ${result.model ?? "the inherited Claude model"}.`
      ]
    };
  }

  private async decide<T>(request: StructuredDecisionRequest): Promise<StructuredDecisionResult<T>> {
    return this.decisions.decide<T>(request);
  }
}

function phaseBriefProposalSchema(input: PhaseBriefPlanningInput): JsonSchema {
  const readAreas = unique([...input.phase.expectedReadAreas, ...input.inspection.filesRead]);
  const writeAreas = unique([
    ...(input.phase.expectedWriteAreas.length > 0 ? input.phase.expectedWriteAreas : input.phase.expectedFilesOrAreas),
    ...supportingTestWriteAreas(input.inspection)
  ]);
  const relevantFiles = unique([...input.inspection.relevantFiles, ...input.inspection.filesRead, ...writeAreas]);
  const relevantSymbols = unique(input.inspection.relevantSymbols);
  const validationCommands = unique(input.phase.validationCommands);
  const acceptanceCriteria = synthesizeObservableAcceptanceCriteria(input.phase.acceptanceCriteria, {
    validationCommands
  });
  const dependencies = unique([...input.phase.dependencies, ...input.phase.dependsOn]);
  const enumStrings = (values: string[], minimum = 0): JsonSchema => values.length > 0
    ? { type: "array", items: { type: "string", enum: values }, minItems: minimum, uniqueItems: true }
    : { type: "array", maxItems: 0 };

  return {
    type: "object",
    properties: {
      objective: { type: "string", minLength: 12, maxLength: 4000 },
      deliverable: { type: "string", minLength: 20, maxLength: 8000 },
      currentBehaviour: { type: "string", minLength: 12, maxLength: 12000 },
      implementationApproach: { type: "string", minLength: 40, maxLength: 16000 },
      readAreas: enumStrings(readAreas),
      writeAreas: enumStrings(writeAreas, writeAreas.length > 0 ? 1 : 0),
      relevantFiles: enumStrings(relevantFiles, relevantFiles.length > 0 ? 1 : 0),
      relevantSymbols: enumStrings(relevantSymbols),
      dependencies: { const: dependencies },
      assumptions: { type: "array", items: { type: "string", minLength: 1, maxLength: 2000 }, maxItems: 12, uniqueItems: true },
      exclusions: { type: "array", items: { type: "string", minLength: 1, maxLength: 2000 }, maxItems: 24, uniqueItems: true },
      // The Workflow Plan owns the requirement. The brief owns the concrete
      // verification evidence, represented as a deterministic non-material
      // refinement of that approved requirement.
      acceptanceCriteria: { const: acceptanceCriteria },
      testObligations: { type: "array", minItems: 1, items: { type: "string", minLength: 8, maxLength: 4000 }, maxItems: 16, uniqueItems: true },
      validationCommands: { const: validationCommands },
      risks: { type: "array", minItems: 1, items: { type: "string", minLength: 8, maxLength: 4000 }, maxItems: 16, uniqueItems: true }
    },
    required: [
      "objective", "deliverable", "currentBehaviour", "implementationApproach",
      "readAreas", "writeAreas", "relevantFiles", "relevantSymbols", "dependencies",
      "assumptions", "exclusions", "acceptanceCriteria", "testObligations", "validationCommands", "risks"
    ],
    additionalProperties: false
  };
}

function buildGenerationPrompt(input: PhaseBriefPlanningInput): string {
  return [
    "You are the Phase Execution Brief author for LeanRigor.",
    "Return only the JSON value required by the supplied schema. You have no repository tools.",
    "Use only the bounded inspection evidence and approved Workflow Phase below. Do not invent paths, symbols, commands, dependencies, acceptance criteria, or repository facts.",
    "Write a genuinely repository-specific, actionable implementation brief. Explain the current behaviour from inspected evidence and give an ordered approach tied to concrete inspected files or symbols.",
    "If test obligations add, update, or extend tests, select a bounded inspected test path in writeAreas. Never require test writes while omitting every test write path.",
    "The schema fixes approval-sensitive fields. Do not try to broaden the phase. LeanRigor will deterministically enforce scope, quality, provenance, and approval safety.",
    input.feedback ? `Revision feedback to incorporate semantically: ${input.feedback}` : undefined,
    "Approved Workflow Phase:", JSON.stringify(input.phase, null, 2),
    "Bounded inspection result:", JSON.stringify(input.inspection, null, 2),
    "Approved constraints:", JSON.stringify(input.state.constraints?.effective.map((entry) => entry.text) ?? input.state.triage?.constraints.mustNot ?? [], null, 2),
    input.previous ? "Previous brief to improve rather than echo:" : undefined,
    input.previous ? JSON.stringify(input.previous, null, 2) : undefined
  ].filter(Boolean).join("\n\n");
}

function buildRepairPrompt(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): string {
  return [
    buildGenerationPrompt(input),
    "Repair only the diagnosed fields. Preserve valid material while making the resulting brief satisfy every diagnostic.",
    "Diagnostics:", JSON.stringify(request.diagnostics, null, 2),
    "Brief requiring repair:", JSON.stringify(request.brief, null, 2)
  ].join("\n\n");
}

function buildAlternatePrompt(input: PhaseBriefPlanningInput, request: PhaseBriefRepairRequest): string {
  return [
    buildGenerationPrompt(input),
    "Use a distinct explanation and implementation structure, but remain entirely within the schema-constrained approved boundary.",
    "Remaining diagnostics:", JSON.stringify(request.diagnostics, null, 2),
    "Prior unsuccessful brief:", JSON.stringify(request.brief, null, 2)
  ].join("\n\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
