import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { collectTriageEvidence, explicitRigorousTriggers, materialUnknowns } from "../src/core/triage-evidence.js";
import type { ReferencedWorkItem } from "../src/core/types.js";
import { extractWorkItemReferences, type WorkItemReference, type WorkItemResolver } from "../src/core/work-item-resolver.js";

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

  it("resolves explicit GitHub issue references before model triage", async () => {
    const root = await fixture();
    const references: WorkItemReference[] = [];
    const resolver: WorkItemResolver = {
      async resolve(reference) {
        references.push(reference);
        return detailedIssue(reference.issueNumber);
      }
    };

    const evidence = await collectTriageEvidence({
      request: "Implement GitHub issue #12: deterministic test-obligation planning and evidence gates.",
      root,
      config: defaultConfig(),
      workItemResolver: resolver
    });

    expect(references[0]).toMatchObject({ source: "github-issue", issueNumber: 12 });
    expect(evidence.referencedWorkItems?.[0]).toMatchObject({
      source: "github-issue",
      repository: "example/leanrigor",
      issueNumber: 12,
      contentStatus: "resolved"
    });
    expect(evidence.referencedWorkItems?.[0]?.acceptanceCriteria).toContain("Completion evidence records obligation IDs and validation results.");
    expect(evidence.deterministicFindings.some((finding) => finding.key.endsWith(".goal"))).toBe(true);
    expect(evidence.deterministicFindings.some((finding) => finding.key.endsWith(".safetyCompatibility"))).toBe(true);
    expect(evidence.changeSignals.namedBoundaries).toEqual(expect.arrayContaining(["workflow state", "planning", "completion gate", "validation evidence", "tests"]));
    expect(evidence.changeSignals.migration).toBe(true);
  });

  it("records unavailable issue lookup explicitly", async () => {
    const root = await fixture();
    const evidence = await collectTriageEvidence({
      request: "Implement GitHub issue #12",
      root,
      config: defaultConfig(),
      workItemResolver: {
        async resolve(reference) {
          return {
            source: "github-issue",
            issueNumber: reference.issueNumber,
            contentStatus: "unavailable",
            truncated: false,
            failureReason: "No GitHub repository remote could be resolved."
          };
        }
      }
    });

    expect(evidence.referencedWorkItems?.[0]?.contentStatus).toBe("unavailable");
    expect(evidence.referencedWorkItems?.[0]?.failureReason).toMatch(/No GitHub repository remote/);
    expect(evidence.deterministicFindings.some((finding) => finding.key.endsWith(".contentStatus") && finding.value === "unavailable")).toBe(true);
  });

  it("does not treat unrelated numeric text as an issue reference", () => {
    expect(extractWorkItemReferences("Update 12 fixtures and 4 docs")).toEqual([]);
    expect(extractWorkItemReferences("Implement owner/repo#12")).toEqual([
      { source: "github-issue", repository: "owner/repo", issueNumber: 12, raw: "owner/repo#12" }
    ]);
  });
});

function detailedIssue(issueNumber: number): ReferencedWorkItem {
  return {
    source: "github-issue",
    repository: "example/leanrigor",
    issueNumber,
    url: `https://github.com/example/leanrigor/issues/${issueNumber}`,
    title: "Add deterministic test-obligation planning and evidence gates",
    body: [
      "## Problem",
      "Validation evidence exists but broad npm test can pass without exercising changed behaviour.",
      "## Goal",
      "Derive explicit test obligations and require completion evidence.",
      "## Desired behaviour",
      "Planning produces phase-specific test obligations for workflow-state persistence, completion evidence gates, validation evidence, and review policy.",
      "## Safety and compatibility",
      "Preserve workflow-state compatibility through defaults or migration. Avoid speculative semantic coverage analysis.",
      "## Acceptance criteria",
      "- Bug-fix plans require a regression obligation.",
      "- Public-contract changes require a contract obligation.",
      "- Completion evidence records obligation IDs and validation results."
    ].join("\n"),
    acceptanceCriteria: [
      "Bug-fix plans require a regression obligation.",
      "Public-contract changes require a contract obligation.",
      "Completion evidence records obligation IDs and validation results."
    ],
    contentStatus: "resolved",
    truncated: false,
    retrievedAt: "2026-07-28T00:00:00.000Z"
  };
}
