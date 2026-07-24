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
  adapter: z.enum(["claude"]).default("claude"),

  /** Personal concrete model mappings per harness adapter. */
  models: z.object({
    claude: z.object({
      small: z.string().min(1).optional(),
      medium: z.string().min(1).optional(),
      large: z.string().min(1).optional()
    }).prefault({})
  }).prefault({}),

  /** Personal execution preferences. */
  execution: z.object({
    defaultProvider: z.enum(["claude-cli", "scripted"]).optional(),
    defaultMode: z.enum(["coordinator", "manual"]).optional(),
    pollIntervalSeconds: z.number().int().min(1).max(3600).optional(),
    workerTimeoutSeconds: z.number().int().min(5).max(86400).optional(),
    heartbeatGraceSeconds: z.number().int().min(1).max(3600).optional(),
    phaseLeaseTimeoutSeconds: z.number().int().min(5).max(86400).optional(),
    workflowLockTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
    parallelism: z.number().int().min(1).max(16).optional(),
    verbosity: z.enum(["quiet", "normal", "verbose"]).optional()
  }).prefault({}),

  /** Machine-specific paths. */
  paths: z.object({
    claudeExecutable: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional()
  }).prefault({})
});

export type UserConfig = z.infer<typeof userConfigSchema>;
