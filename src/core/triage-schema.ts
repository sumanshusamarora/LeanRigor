import { z } from "zod";

const risk = z.enum(["none", "low", "medium", "high"]);
const nonZeroRisk = z.enum(["low", "medium", "high"]);
const mode = z.enum(["fast", "standard", "rigorous"]);
const taskType = z.enum(["bug", "feature", "refactor", "investigation", "maintenance", "documentation", "unknown"]);
const triageQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(240),
  allowedPaths: z.array(z.string().trim().min(1).max(180)).max(8).optional()
});

export const triageOutputSchema = z.object({
  version: z.literal(1),
  task: z.object({
    type: taskType,
    summary: z.string().trim().min(1).max(240)
  }),
  assessment: z.object({
    complexity: z.enum(["low", "medium", "high"]),
    ambiguity: nonZeroRisk,
    blastRadius: nonZeroRisk,
    architecturalImpact: nonZeroRisk,
    securityRisk: risk,
    dataIntegrityRisk: risk,
    operationalRisk: risk
  }),
  workflow: z.object({
    modelRecommendation: mode,
    finalMode: mode,
    confidence: z.number().min(0).max(1),
    parallelism: z.enum(["sequential", "candidate"]),
    reviewLevel: z.enum(["sanity", "integrated", "deep", "specialist"]),
    testLevel: z.enum(["none", "sanity", "targeted", "package", "full"]),
    overridden: z.boolean(),
    overrideReason: z.string().trim().min(1).nullable()
  }),
  clarification: z.object({
    required: z.boolean(),
    question: z.string().trim().min(1).max(300).nullable(),
    reason: z.string().trim().min(1).max(300).nullable()
  }),
  inspection: z.object({
    required: z.boolean(),
    targets: z.array(z.string().trim().min(1).max(180)).max(5)
  }),
  escalationReasons: z.array(z.string().trim().min(1).max(240)).max(3),
  assumptions: z.array(z.string().trim().min(1).max(240)).max(3),
  constraints: z.object({
    mustNot: z.array(z.string().trim().min(1).max(240)).max(6)
  })
}).superRefine((value, ctx) => {
  if (value.clarification.required && (!value.clarification.question || !value.clarification.reason)) {
    ctx.addIssue({ code: "custom", path: ["clarification"], message: "A required clarification must include one question and its reason." });
  }
  if (!value.clarification.required && (value.clarification.question || value.clarification.reason)) {
    ctx.addIssue({ code: "custom", path: ["clarification"], message: "Non-required clarification must use null question and reason." });
  }
  if (value.workflow.overridden && !value.workflow.overrideReason) {
    ctx.addIssue({ code: "custom", path: ["workflow", "overrideReason"], message: "An overridden recommendation requires a reason." });
  }
  if (!value.workflow.overridden && value.workflow.overrideReason) {
    ctx.addIssue({ code: "custom", path: ["workflow", "overrideReason"], message: "An unchanged recommendation must not include an override reason." });
  }
});

export type ParsedTriageOutput = z.infer<typeof triageOutputSchema>;

export const modelTriageRecommendationSchema = z.object({
  version: z.literal(1).default(1),
  complexity: z.enum(["low", "medium", "high"]),
  ambiguity: nonZeroRisk,
  blastRadius: nonZeroRisk,
  risks: z.object({
    architecturalImpact: nonZeroRisk,
    securityRisk: risk,
    dataIntegrityRisk: risk,
    operationalRisk: risk
  }),
  recommendedMode: mode,
  confidence: z.number().min(0).max(1),
  parallelism: z.enum(["sequential", "candidate"]).default("sequential"),
  constraints: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
  approachSummary: z.string().trim().min(1).max(400),
  needsAdditionalInspection: z.boolean().default(false),
  inspectionQuestions: z.array(triageQuestionSchema).max(4).default([]),
  evidenceReferences: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  taskType: taskType.optional(),
  clarification: z.object({
    required: z.boolean(),
    question: z.string().trim().min(1).max(300).nullable(),
    reason: z.string().trim().min(1).max(300).nullable()
  }).optional()
}).superRefine((value, ctx) => {
  if (value.needsAdditionalInspection && value.inspectionQuestions.length === 0) {
    ctx.addIssue({ code: "custom", path: ["inspectionQuestions"], message: "Additional inspection requires concrete questions." });
  }
  if (value.clarification?.required && (!value.clarification.question || !value.clarification.reason)) {
    ctx.addIssue({ code: "custom", path: ["clarification"], message: "A required clarification must include one question and its reason." });
  }
});

export const triageInspectionResultSchema = z.object({
  version: z.literal(1).default(1),
  findings: z.array(z.object({
    key: z.string().trim().min(1).max(120),
    value: z.union([z.string(), z.number(), z.boolean(), z.literal("unknown"), z.array(z.string())]),
    confidence: z.enum(["verified", "inferred", "unknown"]),
    source: z.string().trim().min(1).max(240),
    detail: z.string().trim().min(1).max(500).optional()
  })).max(12),
  evidenceReferences: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  exhaustedBudget: z.boolean().default(false)
});
