import { z } from "zod";

const risk = z.enum(["none", "low", "medium", "high"]);
const nonZeroRisk = z.enum(["low", "medium", "high"]);
const mode = z.enum(["fast", "standard", "rigorous"]);

export const triageOutputSchema = z.object({
  version: z.literal(1),
  task: z.object({
    type: z.enum(["bug", "feature", "refactor", "investigation", "maintenance", "documentation", "unknown"]),
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
