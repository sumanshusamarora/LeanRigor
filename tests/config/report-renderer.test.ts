import { describe, expect, it } from "vitest";
import { renderInitReport } from "../../src/config/report-renderer.js";
import type { InitReport } from "../../src/config/init-report.js";

function baseReport(overrides: Partial<InitReport> = {}): InitReport {
  return {
    configurationFiles: {
      user: { path: "~/.config/leanrigor/config.json", status: "missing" },
      repositoryPolicy: { path: "leanrigor.config.json", status: "missing" },
      local: { path: ".leanrigor/config.json", status: "missing" },
    },
    gitignore: { status: "current", message: ".leanrigor/.gitignore is current" },
    models: [
      {
        tier: "small",
        adapter: "claude",
        adapterAlias: "haiku",
        resolvedModel: "google/gemma-4-31b-it",
        source: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        sourceCode: "adapter-env",
      },
      {
        tier: "medium",
        adapter: "claude",
        adapterAlias: "sonnet",
        resolvedModel: "deepseek/deepseek-v4-pro",
        source: "ANTHROPIC_DEFAULT_SONNET_MODEL",
        sourceCode: "adapter-env",
      },
      {
        tier: "large",
        adapter: "claude",
        adapterAlias: "opus",
        resolvedModel: "gpt-5.5",
        source: "ANTHROPIC_DEFAULT_OPUS_MODEL",
        sourceCode: "adapter-env",
      },
    ],
    execution: {
      "execution.maxParallelPhases": { value: 1, source: "builtin" },
    },
    assets: {
      current: [],
      modified: [],
      missing: [],
      conflicts: [],
      adoptable: [],
      totalAvailable: 22,
      installedCount: 0,
    },
    settings: {
      path: ".claude/settings.json",
      status: "shared_missing_leanrigor_entries",
      detail: "present but does not contain LeanRigor-owned hook entries (shared configuration)",
    },
    isMarketplace: false,
    installationMode: "unknown",
    shadowing: null,
    pluginVersion: "0.0.0-test",
    assetVersion: 1,
    runtimeSource: "local development or global CLI",
    bootstrap: null,
    constraints: [],
    warnings: [],
    validExamples: [
      {
        description: "Set personal small-tier model for all repos",
        command: "leanrigor config set models.claude.small \"claude-haiku-4-5\" --scope user",
        scope: "user",
      },
    ],
    ...overrides,
  };
}

describe("renderInitReport — determinism", () => {
  it("produces identical output for identical input", () => {
    const report = baseReport();
    const out1 = renderInitReport(report);
    const out2 = renderInitReport(report);
    expect(out1).toBe(out2);
  });

  it("renders different model configs differently", () => {
    const a = baseReport();
    const b = baseReport({
      models: [
        {
          tier: "small",
          adapter: "claude",
          adapterAlias: "haiku",
          resolvedModel: "claude-haiku-4-5",
          source: "Claude alias fallback",
          sourceCode: "adapter-default",
        },
        {
          tier: "medium",
          adapter: "claude",
          adapterAlias: "sonnet",
          resolvedModel: "claude-sonnet-5",
          source: "Claude alias fallback",
          sourceCode: "adapter-default",
        },
        {
          tier: "large",
          adapter: "claude",
          adapterAlias: "opus",
          resolvedModel: "claude-opus-4-8",
          source: "Claude alias fallback",
          sourceCode: "adapter-default",
        },
      ],
    });
    expect(renderInitReport(a)).not.toBe(renderInitReport(b));
    // Each individual render is still deterministic
    expect(renderInitReport(a)).toBe(renderInitReport(a));
    expect(renderInitReport(b)).toBe(renderInitReport(b));
  });
});

describe("renderInitReport — model table", () => {
  it("displays Tier, Claude alias, Resolved model, and Source columns", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).toContain("Tier");
    expect(out).toContain("Claude alias");
    expect(out).toContain("Resolved model");
    expect(out).toContain("Source");
  });

  it("shows exact environment variable names in the Source column", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(out).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(out).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });

  it("never fabricates SMALL_MODEL, DEFAULT_MODEL, or similar variable names", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).not.toContain("SMALL_MODEL");
    expect(out).not.toContain("MEDIUM_MODEL");
    expect(out).not.toContain("LARGE_MODEL");
    expect(out).not.toContain("DEFAULT_MODEL");
  });

  it("shows adapter alias distinct from resolved model", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    // "small" row should show alias=haiku and model=google/gemma-4-31b-it
    expect(out).toContain("haiku");
    expect(out).toContain("google/gemma-4-31b-it");
    // Medium: alias sonnet ≠ model deepseek
    expect(out).toContain("sonnet");
    expect(out).toContain("deepseek/deepseek-v4-pro");
    // Large: alias opus ≠ model gpt-5.5
    expect(out).toContain("opus");
    expect(out).toContain("gpt-5.5");
  });
});

describe("renderInitReport — configuration sources", () => {
  it("says adapter-derived and built-in when no config files found", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).toContain("No user, repository-policy, or local configuration files were found");
    expect(out).toContain("Claude adapter-derived model mappings");
    expect(out).toContain("built-in execution defaults");
  });

  it("does NOT say all values are built-in defaults", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).not.toMatch(/all (values are|defaults are|settings are) built-in/i);
  });

  it("reports found config files when they exist", () => {
    const report = baseReport({
      configurationFiles: {
        user: { path: "~/.config/leanrigor/config.json", status: "found" },
        repositoryPolicy: { path: "leanrigor.config.json", status: "missing" },
        local: { path: ".leanrigor/config.json", status: "missing" },
      },
    });
    const out = renderInitReport(report);

    expect(out).toContain("(found)");
    // Should NOT print the "no files found" blurb when a file exists
    expect(out).not.toContain("No user, repository-policy, or local configuration files were found");
  });
});

describe("renderInitReport — shared settings", () => {
  it("shows shared_current settings as shared configuration without conflict warning", () => {
    const report = baseReport({
      settings: {
        path: ".claude/settings.json",
        status: "shared_current",
        detail: "current (LeanRigor hook entries present; coexists with user settings)",
      },
    });
    const out = renderInitReport(report);

    expect(out).toContain("shared Claude Code configuration");
    expect(out).toContain("LeanRigor-owned hook entries are current");
    // Settings should not be described as a conflict
    expect(out).not.toMatch(/settings.*conflict|conflict.*settings/i);
  });

  it("shows shared_unowned as shared config, not as a conflict", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).toContain("shared Claude Code configuration");
    // Settings should not be described as a conflict — it's shared config
    expect(out).not.toMatch(/settings.*conflict|conflict.*settings/i);
  });

  it("shows missing settings with install guidance", () => {
    const report = baseReport({
      settings: {
        path: ".claude/settings.json",
        status: "missing",
        detail: "missing",
      },
    });
    const out = renderInitReport(report);

    expect(out).toContain("missing");
    expect(out).toContain("leanrigor init --adapter claude");
  });
});

describe("renderInitReport — asset drift", () => {
  it("reports modified count without speculating about cause", () => {
    const report = baseReport({
      assets: {
        current: [],
        modified: [".claude/commands/leanrigor-init.md", ".claude/leanrigor/protect-git.sh"],
        missing: [],
        conflicts: [],
        adoptable: [],
        totalAvailable: 22,
        installedCount: 20,
      },
    });
    const out = renderInitReport(report);

    expect(out).toContain("modified: 2");
    expect(out).toContain(".claude/commands/leanrigor-init.md");
    expect(out).toContain(".claude/leanrigor/protect-git.sh");
    // Should NOT guess why assets were modified
    expect(out).not.toMatch(/because|due to|likely|probably|perhaps|maybe|seems/i);
  });

  it("reports 22 modified assets as 22, not as 1", () => {
    const twentyTwoModified = Array.from({ length: 22 }, (_, i) => `.claude/asset-${i}.md`);
    const report = baseReport({
      assets: {
        current: [],
        modified: twentyTwoModified,
        missing: [],
        conflicts: [],
        adoptable: [],
        totalAvailable: 22,
        installedCount: 0,
      },
    });
    const out = renderInitReport(report);

    expect(out).toContain("modified: 22");
  });
});

describe("renderInitReport — valid examples", () => {
  it("includes the validExamples section", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).toContain("Example mutations:");
    expect(out).toContain("leanrigor config set");
  });

  it("renders example commands verbatim", () => {
    const report = baseReport({
      validExamples: [
        {
          description: "Set personal small-tier model for all repos",
          command: 'leanrigor config set models.claude.small "claude-haiku-4-5" --scope user',
          scope: "user",
        },
      ],
    });
    const out = renderInitReport(report);

    expect(out).toContain('leanrigor config set models.claude.small "claude-haiku-4-5" --scope user');
  });
});

describe("renderInitReport — constraints and warnings", () => {
  it("includes constraints section when constraints exist", () => {
    const report = baseReport({
      constraints: ["maxParallelPhases capped at 1 by repository policy"],
    });
    const out = renderInitReport(report);

    expect(out).toContain("Constraints (repository policy)");
    expect(out).toContain("maxParallelPhases capped at 1");
  });

  it("omits constraints section when none exist", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).not.toContain("Constraints (repository policy)");
  });

  it("includes warnings section when warnings exist", () => {
    const report = baseReport({
      warnings: [".leanrigor/workflows/ may contain stale lock files"],
    });
    const out = renderInitReport(report);

    expect(out).toContain("Warnings:");
    expect(out).toContain("⚠");
  });

  it("omits warnings section when none exist", () => {
    const report = baseReport();
    const out = renderInitReport(report);

    expect(out).not.toContain("Warnings:");
  });
});
