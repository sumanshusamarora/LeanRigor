import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { ModelConfigurationError, resolveModelTier, isClaudeAlias } from "../src/config/models.js";

const ENV_KEYS = [
  "LEANRIGOR_MODEL_SMALL",
  "LEANRIGOR_CLAUDE_MODEL_SMALL",
  "LEANRIGOR_OPENCODE_MODEL_SMALL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL"
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portable model tiers", () => {
  it("defaults Claude tiers to adapter-derived aliases (haiku/sonnet/opus)", () => {
    const config = defaultConfig();
    const small = resolveModelTier("small", "claude", config);
    expect(small.model).toBe("haiku");
    expect(small.resolvedModel).toBe("haiku");
    expect(small.adapterAlias).toBe("haiku");
    expect(small.source).toBe("adapter-default");

    const medium = resolveModelTier("medium", "claude", config);
    expect(medium.model).toBe("sonnet");
    expect(medium.resolvedModel).toBe("sonnet");
    expect(medium.adapterAlias).toBe("sonnet");
    expect(medium.source).toBe("adapter-default");

    const large = resolveModelTier("large", "claude", config);
    expect(large.model).toBe("opus");
    expect(large.resolvedModel).toBe("opus");
    expect(large.adapterAlias).toBe("opus");
    expect(large.source).toBe("adapter-default");
  });

  it("prefers ANTHROPIC_DEFAULT_* env vars over Claude alias defaults", () => {
    const config = defaultConfig();
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-4-5-20251001");
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.resolvedModel).toBe("claude-haiku-4-5-20251001");
    expect(resolved.adapterAlias).toBe("haiku");
    expect(resolved.source).toBe("adapter-env");
  });

  it("adapterAlias is set correctly when ANTHROPIC_DEFAULT_* maps to DeepSeek", () => {
    const config = defaultConfig();
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
    vi.stubEnv("ANTHROPIC_DEFAULT_OPUS_MODEL", "deepseek-v4-pro[1m]");
    const small = resolveModelTier("small", "claude", config);
    expect(small.model).toBe("deepseek-v4-flash");
    expect(small.adapterAlias).toBe("haiku");
    expect(small.source).toBe("adapter-env");

    const large = resolveModelTier("large", "claude", config);
    expect(large.model).toBe("deepseek-v4-pro[1m]");
    expect(large.adapterAlias).toBe("opus");
    expect(large.source).toBe("adapter-env");
  });

  it("prefers platform-specific LEANRIGOR_CLAUDE_MODEL_* over ANTHROPIC_DEFAULT_*", () => {
    const config = defaultConfig();
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-4-5");
    vi.stubEnv("LEANRIGOR_CLAUDE_MODEL_SMALL", "my-custom-haiku");
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("my-custom-haiku");
    expect(resolved.resolvedModel).toBe("my-custom-haiku");
    expect(resolved.adapterAlias).toBe("haiku");
    expect(resolved.source).toBe("platform-env");
  });

  it("uses generic environment overrides before config values", () => {
    const config = defaultConfig();
    config.models.tiers.small.claude = "config-haiku";
    vi.stubEnv("LEANRIGOR_MODEL_SMALL", "generic-small");
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("generic-small");
    expect(resolved.resolvedModel).toBe("generic-small");
    expect(resolved.adapterAlias).toBe("haiku");
    expect(resolved.source).toBe("generic-env");
  });

  it("uses config values before adapter defaults", () => {
    const config = defaultConfig();
    config.models.tiers.small.claude = "configured-model";
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("configured-model");
    expect(resolved.resolvedModel).toBe("configured-model");
    expect(resolved.adapterAlias).toBe("haiku");
    expect(resolved.source).toBe("config");
  });

  it("omits a model for inherit tier", () => {
    const config = defaultConfig();
    const resolved = resolveModelTier("inherit", "claude", config);
    expect(resolved).toEqual({ tier: "inherit", source: "inherit" });
    expect(resolved.model).toBeUndefined(); // --model should be omitted
    expect(resolved.resolvedModel).toBeUndefined();
    expect(resolved.adapterAlias).toBeUndefined();
  });

  it("fails clearly when OpenCode tier mappings are absent", () => {
    const config = defaultConfig();
    expect(() => resolveModelTier("small", "opencode", config)).toThrow(ModelConfigurationError);
    expect(() => resolveModelTier("small", "opencode", config)).toThrow(/leanrigor init models/i);
  });

  it("ANTHROPIC_DEFAULT_* only applies to Claude harness", () => {
    const config = defaultConfig();
    vi.stubEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "some-claude-model");
    // OpenCode should not see ANTHROPIC_DEFAULT_*
    expect(() => resolveModelTier("small", "opencode", config)).toThrow(ModelConfigurationError);
  });

  it("adapterAlias is undefined for OpenCode harness", () => {
    const config = defaultConfig();
    config.models.tiers.small.opencode = "openai/gpt-4";
    const resolved = resolveModelTier("small", "opencode", config);
    expect(resolved.model).toBe("openai/gpt-4");
    expect(resolved.resolvedModel).toBe("openai/gpt-4");
    expect(resolved.adapterAlias).toBeUndefined();
    expect(resolved.source).toBe("config");
  });
});

describe("isClaudeAlias", () => {
  it("recognises Claude aliases", () => {
    expect(isClaudeAlias("haiku")).toBe(true);
    expect(isClaudeAlias("sonnet")).toBe(true);
    expect(isClaudeAlias("opus")).toBe(true);
    expect(isClaudeAlias("default")).toBe(true);
  });

  it("returns false for concrete models", () => {
    expect(isClaudeAlias("claude-sonnet-4-5-20251001")).toBe(false);
    expect(isClaudeAlias("deepseek-v4-pro[1m]")).toBe(false);
  });
});
