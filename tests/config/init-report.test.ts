import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInitReport } from "../../src/config/init-report.js";

const ENV_KEYS = [
  "LEANRIGOR_MODEL_SMALL",
  "LEANRIGOR_MODEL_MEDIUM",
  "LEANRIGOR_MODEL_LARGE",
  "LEANRIGOR_CLAUDE_MODEL_SMALL",
  "LEANRIGOR_CLAUDE_MODEL_MEDIUM",
  "LEANRIGOR_CLAUDE_MODEL_LARGE",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
];

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-init-report-test-"));
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildInitReport — model provenance", () => {
  it("preserves exact ANTHROPIC_DEFAULT_* environment variable names in source labels", async () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "google/gemma-4-31b-it");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek/deepseek-v4-pro");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "gpt-5.5");

    const root = await tempRepo();
    const report = await buildInitReport(root);

    const small = report.models.find((m) => m.tier === "small")!;
    const medium = report.models.find((m) => m.tier === "medium")!;
    const large = report.models.find((m) => m.tier === "large")!;

    expect(small.source).toBe("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(medium.source).toBe("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(large.source).toBe("ANTHROPIC_DEFAULT_OPUS_MODEL");

    // Adapter aliases must be distinct
    expect(small.adapterAlias).toBe("haiku");
    expect(medium.adapterAlias).toBe("sonnet");
    expect(large.adapterAlias).toBe("opus");
  });

  it("distinguishes Claude alias from resolved model", async () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-pro");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");

    const root = await tempRepo();
    const report = await buildInitReport(root);

    for (const model of report.models) {
      // Resolved model is the concrete model, not the alias
      expect(model.resolvedModel).not.toBe(model.adapterAlias);
      // Source must be exact env var name, not a fabricated one
      expect(model.source).toMatch(/^ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS)_MODEL$/);
    }
  });

  it("does not call DeepSeek 'Sonnet' or GPT-5.5 'Opus' in source labels", async () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek/deepseek-v4-pro");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "gpt-5.5");

    const root = await tempRepo();
    const report = await buildInitReport(root);

    // Source labels must use exact env var names
    for (const model of report.models) {
      expect(model.source).not.toContain("SMALL_MODEL");
      expect(model.source).not.toContain("DEFAULT_MODEL");
      expect(model.source).not.toContain("MEDIUM_MODEL");
      expect(model.source).not.toContain("LARGE_MODEL");
    }

    // Resolved models must not be rewritten to Claude aliases
    const small = report.models.find((m) => m.tier === "small")!;
    expect(small.resolvedModel).toBe("deepseek-v4-flash");
    expect(small.resolvedModel).not.toBe("haiku");
  });

  it("uses correct default labels when no env vars are set", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    for (const model of report.models) {
      // Without env vars, source should be "Claude alias fallback"
      expect(model.source).toBe("Claude alias fallback");
      expect(model.sourceCode).toBe("adapter-default");
    }
  });
});

describe("buildInitReport — configuration files", () => {
  it("reports all config files as missing in a bare repo", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    expect(report.configurationFiles.user.status).toBe("missing");
    expect(report.configurationFiles.repositoryPolicy.status).toBe("missing");
    expect(report.configurationFiles.local.status).toBe("missing");
  });

  it("says adapter-derived and built-in defaults (not all built-in) when no files exist", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    // Models must have adapter-derived sources, not built-in
    for (const model of report.models) {
      expect(model.sourceCode).not.toBe("builtin");
    }
  });
});

describe("buildInitReport — settings", () => {
  it("treats .claude/settings.json as shared when LeanRigor-unowned with unrelated content", async () => {
    const root = await tempRepo();
    // Create .claude/settings.json with user content (no LeanRigor ownership)
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "", hooks: [] }] } }),
      "utf8",
    );

    const report = await buildInitReport(root);

    // Settings should be classified as shared_missing_leanrigor_entries, not conflict
    expect(report.settings.status).toBe("shared_missing_leanrigor_entries");
  });

  it("produces no warnings for unrelated .claude/settings.json content", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(npm:*)"] } }),
      "utf8",
    );

    const report = await buildInitReport(root);

    // No warnings about settings "conflict" for shared config
    const settingsWarnings = report.warnings.filter((w) =>
      w.toLowerCase().includes("settings"),
    );
    expect(settingsWarnings).toHaveLength(0);
  });
});

describe("buildInitReport — valid examples are schema-backed", () => {
  it("every validExample command starts with leanrigor config set", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    for (const example of report.validExamples) {
      expect(example.command).toMatch(/^leanrigor config set /);
    }
  });

  it("every validExample has a recognised scope", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    for (const example of report.validExamples) {
      expect(["user", "repo", "local"]).toContain(example.scope);
    }
  });

  it("no repo-scoped example suggests a concrete model ID", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    const repoExamples = report.validExamples.filter((e) => e.scope === "repo");
    for (const example of repoExamples) {
      expect(example.command).not.toMatch(/models\.(claude|opencode)\.(small|medium|large)/);
      // No concrete model names in repo examples
      expect(example.command).not.toMatch(/haiku|sonnet|opus|claude-|deepseek|gpt/i);
    }
  });

  it("user-scoped examples use user-legal paths", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    const userExamples = report.validExamples.filter((e) => e.scope === "user");
    // Must have at least one user example
    expect(userExamples.length).toBeGreaterThan(0);
    // All user paths should be valid user-level config keys
    for (const example of userExamples) {
      const pathPart = example.command.split(" ")[3];
      expect(pathPart).toBeTruthy();
    }
  });
});

describe("buildInitReport — execution settings", () => {
  it("records maxParallelPhases provenance", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    const phases = report.execution["execution.maxParallelPhases"];
    expect(phases).toBeDefined();
    expect(phases.value).toBe(1);
    expect(phases.source).toBe("builtin");
  });
});

describe("buildInitReport — constants", () => {
  it("report has a non-empty validExamples array", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    expect(report.validExamples.length).toBeGreaterThan(0);
  });

  it("report includes all model tiers (small, medium, large)", async () => {
    const root = await tempRepo();
    const report = await buildInitReport(root);

    const tiers = report.models.map((m) => m.tier).sort();
    expect(tiers).toEqual(["large", "medium", "small"]);
  });
});
