import { describe, expect, it } from "vitest";
import { provenance, constrainedProvenance, buildProvenanceMap, formatProvenance } from "../src/config/provenance.js";
import { ConfigScope } from "../src/config/config-scope.js";

describe("provenance", () => {
  it("creates a provenance entry with default values", () => {
    const entry = provenance("haiku", ConfigScope.Adapter);
    expect(entry.value).toBe("haiku");
    expect(entry.source).toBe(ConfigScope.Adapter);
    expect(entry.rawValue).toBe("haiku");
    expect(entry.constrained).toBe(false);
    expect(entry.warnings).toEqual([]);
  });

  it("creates constrained provenance", () => {
    const original = provenance(4, ConfigScope.User);
    const constrained = constrainedProvenance(original, 2);

    expect(constrained.value).toBe(2);
    expect(constrained.constrained).toBe(true);
    expect(constrained.requestedValue).toBe(4);
    expect(constrained.warnings.length).toBeGreaterThan(0);
  });

  it("builds provenance map from a flat object", () => {
    const obj = {
      workflow: { defaultMode: "standard" },
      execution: { maxParallelPhases: 3 }
    };

    const map = buildProvenanceMap(obj, ConfigScope.RepoPolicy);
    expect(map.size).toBeGreaterThan(0);
    expect(map.get("workflow.defaultMode")?.source).toBe(ConfigScope.RepoPolicy);
    expect(map.get("workflow.defaultMode")?.value).toBe("standard");
    expect(map.get("execution.maxParallelPhases")?.value).toBe(3);
  });

  it("formats provenance as human-readable text", () => {
    const entry = provenance("large", ConfigScope.RepoPolicy, "large");
    const formatted = formatProvenance("routing.triage", entry);
    expect(formatted).toContain("routing.triage");
    expect(formatted).toContain("large");
    expect(formatted).toContain("repo");
  });
});
