import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { ModelConfigurationError, resolveModelTier } from "../src/config/models.js";

const ENV_KEYS = [
  "LEANRIGOR_MODEL_SMALL",
  "LEANRIGOR_CLAUDE_MODEL_SMALL",
  "LEANRIGOR_OPENCODE_MODEL_SMALL"
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("portable model tiers", () => {
  it("defaults Claude tiers to provider-resolved aliases", () => {
    const config = defaultConfig();
    expect(resolveModelTier("small", "claude", config).model).toBe("haiku");
    expect(resolveModelTier("medium", "claude", config).model).toBe("sonnet");
    expect(resolveModelTier("large", "claude", config).model).toBe("opus");
  });

  it("prefers platform-specific environment overrides", () => {
    const config = defaultConfig();
    process.env.LEANRIGOR_MODEL_SMALL = "generic-small";
    process.env.LEANRIGOR_CLAUDE_MODEL_SMALL = "company-haiku-deployment";
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("company-haiku-deployment");
    expect(resolved.source).toBe("platform-env");
  });

  it("uses generic environment overrides before config", () => {
    const config = defaultConfig();
    process.env.LEANRIGOR_MODEL_SMALL = "generic-small";
    const resolved = resolveModelTier("small", "claude", config);
    expect(resolved.model).toBe("generic-small");
    expect(resolved.source).toBe("generic-env");
  });

  it("omits a model for inherit", () => {
    const config = defaultConfig();
    expect(resolveModelTier("inherit", "claude", config)).toEqual({ tier: "inherit", source: "inherit" });
  });

  it("fails clearly when OpenCode tier mappings are absent", () => {
    const config = defaultConfig();
    expect(() => resolveModelTier("small", "opencode", config)).toThrow(ModelConfigurationError);
    expect(() => resolveModelTier("small", "opencode", config)).toThrow(/leanrigor init models/i);
  });
});
