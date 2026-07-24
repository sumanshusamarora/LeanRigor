import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { leanRigorConfigSchema } from "../src/config/schema.js";
import {
  formatModelResolution,
  formatModelTierLine,
  formatAllModelTiers,
  formatModelTable,
  claudeDefaultsBlurb,
  formatModelTierJson,
  formatAllModelTiersJson,
  modelSourceLabel,
} from "../src/config/model-display.js";

const ENV_KEYS = [
  "LEANRIGOR_MODEL_SMALL", "LEANRIGOR_CLAUDE_MODEL_SMALL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"
];

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

// ---------------------------------------------------------------------------
// formatModelResolution
// ---------------------------------------------------------------------------
describe("formatModelResolution", () => {
  it("builds structured display info for adapter-default source", () => {
    const info = formatModelResolution("small", "claude", defaultConfig());
    expect(info.tier).toBe("small");
    expect(info.adapterAlias).toBe("haiku");
    expect(info.resolvedModel).toBe("haiku");
    expect(info.source).toBe("adapter-default");
    expect(info.isClaudeAlias).toBe(true);
    expect(info.sourceLabel).toContain("Claude alias fallback");
  });

  it("builds structured display info for adapter-env source", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    const info = formatModelResolution("small", "claude", defaultConfig());
    expect(info.tier).toBe("small");
    expect(info.adapterAlias).toBe("haiku");
    expect(info.resolvedModel).toBe("deepseek-v4-flash");
    expect(info.source).toBe("adapter-env");
    expect(info.isClaudeAlias).toBe(false);
    expect(info.sourceLabel).toBe("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("reports correct source label for each tier", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-pro[1m]");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");

    const small = formatModelResolution("small", "claude", defaultConfig());
    const medium = formatModelResolution("medium", "claude", defaultConfig());
    const large = formatModelResolution("large", "claude", defaultConfig());

    expect(small.sourceLabel).toBe("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(medium.sourceLabel).toBe("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(large.sourceLabel).toBe("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });

  it("returns undefined adapterAlias for non-Claude harness", () => {
    const config = defaultConfig();
    config.models.tiers.small.opencode = "openai/gpt-4";
    const info = formatModelResolution("small", "opencode", config);
    expect(info.adapterAlias).toBeUndefined();
    expect(info.resolvedModel).toBe("openai/gpt-4");
  });

  it("handles inherit tier", () => {
    const info = formatModelResolution("inherit", "claude", defaultConfig());
    expect(info.adapterAlias).toBeUndefined();
    expect(info.resolvedModel).toBeUndefined();
    expect(info.source).toBe("inherit");
  });
});

// ---------------------------------------------------------------------------
// formatModelTierLine
// ---------------------------------------------------------------------------
describe("formatModelTierLine", () => {
  it("formats adapter-default alias correctly", () => {
    const line = formatModelTierLine("small", "claude", defaultConfig());
    expect(line).toContain("small:");
    expect(line).toContain("haiku");
    expect(line).toContain("Claude alias fallback");
  });

  it("shows alias → model when concrete model differs from alias", () => {
    const config = leanRigorConfigSchema.parse({
      models: { tiers: { small: { claude: "claude-sonnet-4-5-20251001" } } }
    });
    const line = formatModelTierLine("small", "claude", config);
    expect(line).toContain("haiku");
    expect(line).toContain("→");
    expect(line).toContain("claude-sonnet-4-5-20251001");
  });

  it("shows alias → model when ANTHROPIC_DEFAULT_* maps to a different model", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    const line = formatModelTierLine("small", "claude", defaultConfig());
    expect(line).toContain("haiku");
    expect(line).toContain("→");
    expect(line).toContain("deepseek-v4-flash");
    expect(line).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("formats inherit tier", () => {
    const line = formatModelTierLine("inherit", "claude", defaultConfig());
    expect(line).toContain("inherit");
    expect(line).toContain("no model assigned");
  });

  it("handles platform env variable override", () => {
    vi.stubEnv("LEANRIGOR_CLAUDE_MODEL_SMALL", "my-custom-model");
    const line = formatModelTierLine("small", "claude", defaultConfig());
    expect(line).toContain("haiku → my-custom-model");
    expect(line).toContain("LEANRIGOR_CLAUDE_MODEL_SMALL");
  });

  it("handles generic env variable override", () => {
    vi.stubEnv("LEANRIGOR_MODEL_MEDIUM", "generic-medium-model");
    const line = formatModelTierLine("medium", "claude", defaultConfig());
    expect(line).toContain("sonnet → generic-medium-model");
    expect(line).toContain("LEANRIGOR_MODEL_MEDIUM");
  });

  it("handles config value override", () => {
    const config = leanRigorConfigSchema.parse({
      models: { tiers: { large: { claude: "configured-large-model" } } }
    });
    const line = formatModelTierLine("large", "claude", config);
    expect(line).toContain("opus → configured-large-model");
    expect(line).toContain("LeanRigor configuration file");
  });

  it("does NOT call a non-Anthropic model Opus", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");
    const line = formatModelTierLine("large", "claude", defaultConfig());
    // The line should mention the alias "opus" but the resolved model "deepseek-v4-pro[1m]"
    expect(line).toContain("opus");
    expect(line).toContain("→");
    expect(line).toContain("deepseek-v4-pro[1m]");
    // It should NOT say just "large: opus" as if opus IS the model
    expect(line).not.toMatch(/large:\s+opus\s+\(source/);
  });

  it("does NOT call a non-Anthropic model Sonnet", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-pro[1m]");
    const line = formatModelTierLine("medium", "claude", defaultConfig());
    expect(line).toContain("sonnet");
    expect(line).toContain("→");
    expect(line).toContain("deepseek-v4-pro[1m]");
    expect(line).not.toMatch(/medium:\s+sonnet\s+\(source/);
  });

  it("does NOT call a non-Anthropic model Haiku", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    const line = formatModelTierLine("small", "claude", defaultConfig());
    expect(line).toContain("haiku");
    expect(line).toContain("→");
    expect(line).toContain("deepseek-v4-flash");
    expect(line).not.toMatch(/small:\s+haiku\s+\(source/);
  });
});

// ---------------------------------------------------------------------------
// formatAllModelTiers
// ---------------------------------------------------------------------------
describe("formatAllModelTiers", () => {
  it("returns three lines for small/medium/large", () => {
    const lines = formatAllModelTiers("claude", defaultConfig());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("small");
    expect(lines[1]).toContain("medium");
    expect(lines[2]).toContain("large");
  });

  it("handles errors gracefully", () => {
    // OpenCode harness without configured tiers should produce an error line
    const lines = formatAllModelTiers("opencode", defaultConfig());
    expect(lines).toHaveLength(3);
    // Each line should contain either a model or ERROR
    for (const line of lines) {
      expect(line.includes("ERROR") || line.includes("model")).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// formatModelTable
// ---------------------------------------------------------------------------
describe("formatModelTable", () => {
  it("produces a table with expected headers", () => {
    const table = formatModelTable("claude", defaultConfig());
    expect(table).toContain("Tier");
    expect(table).toContain("Claude alias");
    expect(table).toContain("Resolved model");
    expect(table).toContain("Source");
  });

  it("includes all four tiers", () => {
    const table = formatModelTable("claude", defaultConfig());
    expect(table).toContain("small");
    expect(table).toContain("medium");
    expect(table).toContain("large");
    expect(table).toContain("inherit");
  });

  it("shows inherit as session default with --model omitted", () => {
    const table = formatModelTable("claude", defaultConfig());
    expect(table).toContain("(session default)");
    expect(table).toContain("--model omitted");
  });

  it("shows resolved models from ANTHROPIC_DEFAULT_*", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    vi.stubEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-pro[1m]");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");
    const table = formatModelTable("claude", defaultConfig());
    expect(table).toContain("deepseek-v4-flash");
    expect(table).toContain("deepseek-v4-pro[1m]");
    expect(table).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(table).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(table).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });
});

// ---------------------------------------------------------------------------
// claudeDefaultsBlurb
// ---------------------------------------------------------------------------
describe("claudeDefaultsBlurb", () => {
  it("returns formatted defaults with tier→alias notation", () => {
    const blurb = claudeDefaultsBlurb();
    expect(blurb).toContain("small → haiku");
    expect(blurb).toContain("medium → sonnet");
    expect(blurb).toContain("large → opus");
  });
});

// ---------------------------------------------------------------------------
// formatModelTierJson
// ---------------------------------------------------------------------------
describe("formatModelTierJson", () => {
  it("returns structured JSON with unambiguous fields", () => {
    const json = formatModelTierJson("small", "claude", defaultConfig());
    expect(json.tier).toBe("small");
    expect(json.adapter).toBe("claude");
    expect(json.adapterAlias).toBe("haiku");
    expect(json.resolvedModel).toBe("haiku");
    expect(json.source).toBe("adapter-default");
    expect(json.sourceLabel).toBeDefined();
    expect(json.isClaudeAlias).toBe(true);
  });

  it("distinguishes concrete model from alias in JSON", () => {
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");
    const json = formatModelTierJson("large", "claude", defaultConfig());
    expect(json.adapterAlias).toBe("opus");
    expect(json.resolvedModel).toBe("deepseek-v4-pro[1m]");
    expect(json.isClaudeAlias).toBe(false);
  });

  it("JSON never has model field named just 'model' without resolvedModel", () => {
    const json = formatModelTierJson("small", "claude", defaultConfig());
    // 'resolvedModel' is the canonical field; 'model' should not appear
    expect(json.resolvedModel).toBeDefined();
    expect(Object.keys(json)).toContain("resolvedModel");
    expect(Object.keys(json)).not.toContain("model");
  });

  it("uses null for missing values", () => {
    const json = formatModelTierJson("inherit", "claude", defaultConfig());
    expect(json.resolvedModel).toBeNull();
    expect(json.adapterAlias).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatAllModelTiersJson
// ---------------------------------------------------------------------------
describe("formatAllModelTiersJson", () => {
  it("returns array of three objects", () => {
    const arr = formatAllModelTiersJson("claude", defaultConfig());
    expect(arr).toHaveLength(3);
    for (const entry of arr) {
      expect(entry.tier).toBeDefined();
      expect(entry.resolvedModel).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// modelSourceLabel
// ---------------------------------------------------------------------------
describe("modelSourceLabel", () => {
  it("returns specific env var names for adapter-env with tier", () => {
    expect(modelSourceLabel("adapter-env", "small", "claude")).toBe("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(modelSourceLabel("adapter-env", "medium", "claude")).toBe("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(modelSourceLabel("adapter-env", "large", "claude")).toBe("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });

  it("returns specific env var names for platform-env with tier", () => {
    expect(modelSourceLabel("platform-env", "small", "claude")).toBe("LEANRIGOR_CLAUDE_MODEL_SMALL");
    expect(modelSourceLabel("platform-env", "large", "opencode")).toBe("LEANRIGOR_OPENCODE_MODEL_LARGE");
  });

  it("returns specific env var names for generic-env with tier", () => {
    expect(modelSourceLabel("generic-env", "medium")).toBe("LEANRIGOR_MODEL_MEDIUM");
  });

  it("returns generic label when tier is omitted", () => {
    // Without tier info, returns a generic descriptor
    expect(modelSourceLabel("adapter-env")).toBeDefined();
    expect(modelSourceLabel("platform-env")).toBeDefined();
    expect(modelSourceLabel("generic-env")).toContain("LEANRIGOR_MODEL_");
  });

  it("returns correct labels for other sources", () => {
    expect(modelSourceLabel("config")).toBe("LeanRigor configuration file");
    expect(modelSourceLabel("adapter-default")).toBe("Claude alias fallback");
    expect(modelSourceLabel("inherit")).toBe("inherited (no model specified)");
  });
});
