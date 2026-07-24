import { z } from "zod";
import { leanRigorConfigSchema, type LeanRigorConfig } from "../schema.js";

/**
 * Private per-repository configuration schema.
 * Stored at <repo>/.leanrigor/config.json — never committed.
 *
 * Contains concrete model mappings, execution settings with machine-specific
 * paths, local overrides, and all settings from the full config schema.
 *
 * This is backward-compatible with the existing LeanRigorConfig schema.
 */
export const localRepoConfigSchema = leanRigorConfigSchema;

export type LocalRepoConfig = LeanRigorConfig;

/** Subset of local config that can differ per machine/contributor. */
export const localOverridesSchema = z.object({
  models: z.object({
    tiers: z.object({
      small: z.object({
        claude: z.string().min(1).optional(),
        opencode: z.string().min(1).optional()
      }).prefault({}),
      medium: z.object({
        claude: z.string().min(1).optional(),
        opencode: z.string().min(1).optional()
      }).prefault({}),
      large: z.object({
        claude: z.string().min(1).optional(),
        opencode: z.string().min(1).optional()
      }).prefault({})
    }).prefault({})
  }).prefault({}),
  execution: z.object({
    workspaceRoot: z.string().min(1).nullable().optional(),
    pollIntervalSeconds: z.number().int().min(1).optional(),
    workerTimeoutSeconds: z.number().int().min(5).optional()
  }).prefault({})
}).prefault({});

export type LocalOverrides = z.infer<typeof localOverridesSchema>;
