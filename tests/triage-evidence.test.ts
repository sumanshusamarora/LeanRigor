import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { collectTriageEvidence, explicitRigorousTriggers, materialUnknowns } from "../src/core/triage-evidence.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "leanrigor-triage-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3.0.0" } }), "utf8");
  await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
  await mkdir(path.join(root, "tests"));
  await mkdir(path.join(root, "migrations"));
  await mkdir(path.join(root, "infra"));
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

describe("triage evidence collection", () => {
  it("creates deterministic request-only evidence with unknown material risks", async () => {
    const root = await fixture();
    const config = defaultConfig();
    const a = await collectTriageEvidence({ request: "Improve assignment behavior", root, config });
    const b = await collectTriageEvidence({ request: "Improve assignment behavior", root, config });

    expect(a.version).toBe(1);
    expect(a.request.text).toBe("Improve assignment behavior");
    expect(a.changeSignals.security).toBe("unknown");
    expect(materialUnknowns(a)).toContain("security");
    expect(b.changeSignals).toEqual(a.changeSignals);
  });

  it("captures explicitly named paths without recursive repository exploration", async () => {
    const root = await fixture();
    const evidence = await collectTriageEvidence({ request: "Fix typo in `README.md`", root, config: defaultConfig() });

    expect(evidence.request.explicitlyNamedPaths).toEqual(["README.md"]);
    expect(evidence.deterministicFindings.some((finding) => finding.key === "path.README.md" && finding.value === "file")).toBe(true);
    expect(evidence.deterministicFindings.length).toBeLessThan(40);
  });

  it("keeps documentation-only material risks as deterministic low-risk inferences", async () => {
    const root = await fixture();
    const evidence = await collectTriageEvidence({ request: "Fix typo in README.md documentation", root, config: defaultConfig() });

    expect(evidence.changeSignals.taskType).toBe("documentation");
    expect(evidence.changeSignals.security).toBe(false);
    expect(materialUnknowns(evidence)).toEqual([]);
  });

  it("detects migration, security, and infrastructure signals from the request", async () => {
    const root = await fixture();
    const evidence = await collectTriageEvidence({
      request: "Add authenticated production database migration for billing data",
      root,
      config: defaultConfig()
    });

    expect(evidence.changeSignals.migration).toBe(true);
    expect(evidence.changeSignals.security).toBe(true);
    expect(evidence.changeSignals.productionInfrastructure).toBe(true);
    expect(explicitRigorousTriggers(evidence)).toEqual(expect.arrayContaining(["migration", "security", "production infrastructure"]));
  });
});
