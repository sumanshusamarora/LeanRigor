import { scopePath } from "./config-scope.js";
import { loadUserConfig, loadRepoPolicy, configFileExists } from "./load.js";
import { ConfigScope } from "./config-scope.js";
import { resolveEffectiveConfig } from "./resolver.js";
import { formatModelTierJson } from "./model-display.js";
import { ClaudeAdapter, type AssetInspectionResult } from "../adapters/claude/adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitReport {
  configurationFiles: {
    user: { path: string; status: "found" | "missing" };
    repositoryPolicy: { path: string; status: "found" | "missing" };
    local: { path: string; status: "found" | "missing" };
  };
  gitignore: AssetInspectionResult["gitignoreStatus"];
  models: Array<{
    tier: string;
    adapter: string;
    adapterAlias: string | null;
    resolvedModel: string | null;
    source: string;
    sourceCode: string;
  }>;
  execution: Record<string, { value: unknown; source: string }>;
  assets: {
    current: string[];
    modified: string[];
    missing: string[];
    conflicts: string[];
    totalAvailable: number;
    installedCount: number;
  };
  settings: {
    path: string;
    status: AssetInspectionResult["settingsState"];
    detail: string;
  };
  constraints: string[];
  warnings: string[];
  validExamples: Array<{ description: string; command: string; scope: string }>;
}

// ---------------------------------------------------------------------------
// Schema-backed valid command examples
// ---------------------------------------------------------------------------

interface ExampleEntry {
  description: string;
  path: string;
  example: string;
  scope: "user" | "repo" | "local";
}

const VALID_EXAMPLES: ExampleEntry[] = [
  // User-level (userConfigSchema)
  {
    description: "Set personal small-tier model for all repos",
    path: "models.claude.small",
    example: '"claude-haiku-4-5"',
    scope: "user",
  },
  {
    description: "Set personal medium-tier model for all repos",
    path: "models.claude.medium",
    example: '"claude-sonnet-5"',
    scope: "user",
  },
  {
    description: "Set personal large-tier model for all repos",
    path: "models.claude.large",
    example: '"claude-opus-4-8"',
    scope: "user",
  },
  {
    description: "Increase personal parallelism",
    path: "execution.parallelism",
    example: "4",
    scope: "user",
  },
  {
    description: "Set personal execution verbosity",
    path: "execution.verbosity",
    example: '"verbose"',
    scope: "user",
  },
  // Repo policy (repoPolicyConfigSchema — no concrete model IDs)
  {
    description: "Set project default workflow mode",
    path: "workflow.defaultMode",
    example: '"standard"',
    scope: "repo",
  },
  {
    description: "Set minimum review level for rigorous mode",
    path: "review.rigorous",
    example: '"specialist"',
    scope: "repo",
  },
  {
    description: "Require completion evidence across all modes",
    path: "safety.requireEvidence",
    example: "true",
    scope: "repo",
  },
  {
    description: "Add paths that trigger rigorous review",
    path: "safety.rigorousPaths",
    example: '["auth/**", "payments/**"]',
    scope: "repo",
  },
  {
    description: "Set minimum planning tier for the team",
    path: "minimumTiers.planning",
    example: '"medium"',
    scope: "repo",
  },
  {
    description: "Set minimum review level for standard mode",
    path: "review.standard",
    example: '"deep"',
    scope: "repo",
  },
  {
    description: "Set testing requirement for public API changes",
    path: "testing.publicApi",
    example: '"contract-required"',
    scope: "repo",
  },
  // Local (leanRigorConfigSchema — full schema)
  {
    description: "Set local max parallel phases (this repo only)",
    path: "execution.maxParallelPhases",
    example: "2",
    scope: "local",
  },
  {
    description: "Set local default workflow mode",
    path: "workflow.defaultMode",
    example: '"fast"',
    scope: "local",
  },
  {
    description: "Set local poll interval for execution",
    path: "execution.pollIntervalSeconds",
    example: "10",
    scope: "local",
  },
  {
    description: "Set local phase lease timeout",
    path: "execution.phaseLeaseTimeoutSeconds",
    example: "1800",
    scope: "local",
  },
];

function buildExampleCommands(): InitReport["validExamples"] {
  return VALID_EXAMPLES.map((entry) => ({
    description: entry.description,
    command: `leanrigor config set ${entry.path} ${entry.example} --scope ${entry.scope}`,
    scope: entry.scope,
  }));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the unified structured init report from all diagnostic sources.
 *
 * This is the single source of truth for `/leanrigor:init` — the
 * conversational layer should display the rendered output as-is and
 * never independently reconstruct diagnostics.
 */
export async function buildInitReport(root: string): Promise<InitReport> {
  // --- Resolve effective config ---
  const effective = await resolveEffectiveConfig(root);

  // --- Configuration files ---
  const userConfig = await loadUserConfig();
  const repoPolicy = await loadRepoPolicy(root);
  const localExists = await configFileExists(ConfigScope.Local, root);

  const configurationFiles: InitReport["configurationFiles"] = {
    user: {
      path: scopePath(ConfigScope.User, ""),
      status: userConfig ? "found" : "missing",
    },
    repositoryPolicy: {
      path: scopePath(ConfigScope.RepoPolicy, root),
      status: repoPolicy ? "found" : "missing",
    },
    local: {
      path: scopePath(ConfigScope.Local, root),
      status: localExists ? "found" : "missing",
    },
  };

  // --- Model tiers ---
  const models = (["small", "medium", "large"] as const).map((tier) => {
    const json = formatModelTierJson(tier, "claude", effective.values);
    return {
      tier: json.tier as string,
      adapter: json.adapter as string,
      adapterAlias: json.adapterAlias as string | null,
      resolvedModel: json.resolvedModel as string | null,
      source: json.sourceLabel as string,
      sourceCode: json.source as string,
    };
  });

  // --- Execution settings ---
  const execution: InitReport["execution"] = {};
  for (const [key, entry] of effective.provenance) {
    if (key.startsWith("execution.")) {
      execution[key] = { value: entry.value, source: entry.source };
    }
  }

  // --- Assets and settings ---
  const inspection = await new ClaudeAdapter().inspectAssets(root, effective.values);

  // --- Build report ---
  return {
    configurationFiles,
    gitignore: inspection.gitignoreStatus,
    models,
    execution,
    assets: {
      current: inspection.current,
      modified: inspection.modified,
      missing: inspection.missing,
      conflicts: inspection.conflicts,
      totalAvailable: inspection.totalAvailable,
      installedCount: inspection.installedCount,
    },
    settings: {
      path: ".claude/settings.json",
      status: inspection.settingsState,
      detail: inspection.settingsDetail,
    },
    constraints: effective.constraints,
    warnings: effective.warnings,
    validExamples: buildExampleCommands(),
  };
}
