import { z } from "zod";

/**
 * User-wide configuration schema.
 * Stored at ~/.config/leanrigor/config.json
 *
 * Contains personal preferences, concrete model mappings, and
 * machine-specific settings that span multiple repositories.
 * This file is optional — LeanRigor works fully without it.
 */
export const userConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),

  /** Preferred harness adapter. */
  adapter: z.string().min(1).default("claude"),

  /** Personal concrete model mappings per harness adapter. */
  models: z.record(z.string().min(1), z.object({
    small: z.string().min(1).optional(),
    medium: z.string().min(1).optional(),
    large: z.string().min(1).optional()
  })).default({}),

  /** Personal execution preferences. */
  execution: z.object({
    defaultProvider: z.string().min(1).optional(),
    defaultMode: z.enum(["coordinator", "manual"]).optional(),
    pollIntervalSeconds: z.number().int().min(1).max(3600).optional(),
    workerTimeoutSeconds: z.number().int().min(5).max(86400).optional(),
    heartbeatGraceSeconds: z.number().int().min(1).max(3600).optional(),
    phaseLeaseTimeoutSeconds: z.number().int().min(5).max(86400).optional(),
    workflowLockTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
    parallelism: z.number().int().min(1).max(16).optional(),
    verbosity: z.enum(["quiet", "normal", "verbose"]).optional(),
    workerControls: z.object({
      environment: z.enum(["bare", "safe-mode", "default"]).optional(),
      maxTurns: z.object({
        fast: z.number().int().min(1).max(200).optional(),
        standard: z.number().int().min(1).max(200).optional(),
        rigorous: z.number().int().min(1).max(200).optional()
      }).optional(),
      extensionTurns: z.object({
        fast: z.number().int().min(1).max(100).optional(),
        standard: z.number().int().min(1).max(100).optional(),
        rigorous: z.number().int().min(1).max(100).optional()
      }).optional(),
      repeatedReadWarningThreshold: z.number().int().min(1).max(20).optional(),
      largeToolOutputBytes: z.number().int().min(1024).max(1048576).optional()
    }).optional()
  }).prefault({}),

  /** Machine-specific paths. */
  paths: z.object({
    claudeExecutable: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional()
  }).prefault({})
});

export type UserConfig = z.infer<typeof userConfigSchema>;
