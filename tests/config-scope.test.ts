import { describe, expect, it } from "vitest";
import {
  ConfigScope,
  PRECEDENCE,
  scopePath,
  REPO_POLICY_FORBIDDEN_KEYS,
  SAFETY_CONSTRAINT_KEYS,
  MINIMUM_TIER_KEYS,
  strongerTier
} from "../src/config/config-scope.js";

describe("ConfigScope", () => {
  it("has all expected scope values", () => {
    expect(ConfigScope.Cli).toBe("cli");
    expect(ConfigScope.Env).toBe("env");
    expect(ConfigScope.Local).toBe("local");
    expect(ConfigScope.RepoPolicy).toBe("repo");
    expect(ConfigScope.User).toBe("user");
    expect(ConfigScope.Adapter).toBe("adapter");
    expect(ConfigScope.Builtin).toBe("builtin");
  });

  it("has correct precedence order (lowest to highest)", () => {
    expect(PRECEDENCE).toEqual([
      ConfigScope.Builtin,
      ConfigScope.Adapter,
      ConfigScope.User,
      ConfigScope.RepoPolicy,
      ConfigScope.Local,
      ConfigScope.Env,
      ConfigScope.Cli
    ]);
  });

  it("resolves scope paths correctly", () => {
    const userPath = scopePath(ConfigScope.User, "/tmp/repo");
    expect(userPath).toContain(".config/leanrigor/config.json");

    const repoPath = scopePath(ConfigScope.RepoPolicy, "/tmp/repo");
    expect(repoPath).toBe("/tmp/repo/leanrigor.config.json");

    const localPath = scopePath(ConfigScope.Local, "/tmp/repo");
    expect(localPath).toBe("/tmp/repo/.leanrigor/config.json");
  });

  it("prevents concrete model IDs in committed repo policy", () => {
    expect(REPO_POLICY_FORBIDDEN_KEYS).toContain("models.tiers.small.claude");
    expect(REPO_POLICY_FORBIDDEN_KEYS).toContain("models.tiers.medium.claude");
    expect(REPO_POLICY_FORBIDDEN_KEYS).toContain("models.tiers.large.claude");
    expect(REPO_POLICY_FORBIDDEN_KEYS).toContain("execution.workspaceRoot");
  });

  it("identifies safety constraint keys", () => {
    expect(SAFETY_CONSTRAINT_KEYS).toContain("parallelism.maxPhases");
    expect(SAFETY_CONSTRAINT_KEYS).toContain("completionGate.requireEvidence");
    expect(SAFETY_CONSTRAINT_KEYS).toContain("completionGate.enabled");
  });

  it("identifies minimum tier keys", () => {
    expect(MINIMUM_TIER_KEYS).toContain("minimumTiers.triage");
    expect(MINIMUM_TIER_KEYS).toContain("minimumTiers.review");
  });

  it("strongerTier picks the highest tier", () => {
    expect(strongerTier("small", "medium")).toBe("medium");
    expect(strongerTier("large", "small")).toBe("large");
    expect(strongerTier("inherit", "small")).toBe("small");
    expect(strongerTier("large", "large")).toBe("large");
  });
});
