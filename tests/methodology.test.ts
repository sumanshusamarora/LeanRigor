import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { ClaudeAdapter } from "../src/adapters/claude/adapter.js";
import { defaultConfig } from "../src/config/defaults.js";
import { approveApproach, startFlow } from "../src/core/flow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const methodologyFiles = [
  "core.md",
  "planning.md",
  "design.md",
  "implementation.md",
  "debugging.md",
  "testing.md",
  "review.md",
  "evidence.md",
  "safeguards.md",
  path.join("modes", "fast.md"),
  path.join("modes", "standard.md"),
  path.join("modes", "rigorous.md")
];

async function readMethodology(file: string): Promise<string> {
  return readFile(path.join(repoRoot, "methodology", file), "utf8");
}

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-methodology-"));
}

describe("engineering methodology assets", () => {
  it("has the required shared structure and no root skills directory", async () => {
    for (const file of methodologyFiles) {
      await expect(access(path.join(repoRoot, "methodology", file))).resolves.toBeUndefined();
    }
    await expect(access(path.join(repoRoot, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps methodology out of user-facing slash commands", async () => {
    const commandFiles = await readdir(path.join(repoRoot, "commands"));
    expect(commandFiles.sort()).toEqual(["commit.md", "plan.md", "review.md", "start.md", "status.md"]);
    for (const command of commandFiles) {
      const content = await readFile(path.join(repoRoot, "commands", command), "utf8");
      expect(content).not.toContain("Core Engineering Methodology");
      expect(content).not.toContain("Strong Evidence");
    }
  });

  it("uses compact mode overlays with distinct guidance", async () => {
    const fast = await readMethodology(path.join("modes", "fast.md"));
    const standard = await readMethodology(path.join("modes", "standard.md"));
    const rigorous = await readMethodology(path.join("modes", "rigorous.md"));

    expect(fast.length).toBeLessThan(1600);
    expect(fast).toMatch(/briefly inspect/i);
    expect(fast).toMatch(/smallest change/i);
    expect(fast).toMatch(/diff sanity/i);
    expect(fast).toMatch(/avoid unnecessary alternatives, design documents/i);

    expect(standard).toMatch(/disciplined engineering defaults/i);
    expect(standard).toMatch(/call paths/i);
    expect(standard).toMatch(/targeted tests/i);
    expect(standard).toMatch(/integrated review/i);

    expect(rigorous).toMatch(/security/i);
    expect(rigorous).toMatch(/migration/i);
    expect(rigorous).toMatch(/rollback/i);
    expect(rigorous).toMatch(/operational/i);
    expect(rigorous).toMatch(/specialist review/i);
  });

  it("covers planning, debugging, testing, evidence, and safeguard concepts", async () => {
    const planning = await readMethodology("planning.md");
    expect(planning).toMatch(/desired outcome/i);
    expect(planning).toMatch(/current behavior/i);
    expect(planning).toMatch(/acceptance criteria/i);
    expect(planning).toMatch(/facts from assumptions/i);

    const debugging = await readMethodology("debugging.md");
    expect(debugging).toMatch(/reproduce[\s\S]*observe[\s\S]*narrow[\s\S]*form hypotheses/i);
    expect(debugging).toMatch(/root cause/i);
    expect(debugging).toMatch(/regression coverage/i);

    const testing = await readMethodology("testing.md");
    expect(testing).toMatch(/Fast:/);
    expect(testing).toMatch(/Standard:/);
    expect(testing).toMatch(/Rigorous:/);
    expect(testing).toMatch(/no automated test is practical/i);

    const evidence = await readMethodology("evidence.md");
    expect(evidence).toMatch(/Strong Evidence/i);
    expect(evidence).toMatch(/Weak Evidence/i);
    expect(evidence).toMatch(/claim[\s\S]*evidence[\s\S]*verification status[\s\S]*remaining uncertainty/i);

    const safeguards = await readMethodology("safeguards.md");
    expect(safeguards).toMatch(/Security And Privacy/i);
    expect(safeguards).toMatch(/Migration And Data/i);
    expect(safeguards).toMatch(/APIs And Contracts/i);
    expect(safeguards).toMatch(/Production And Operations/i);
  });

  it("documents deterministic and prompt responsibilities once in the core methodology", async () => {
    const core = await readMethodology("core.md");
    expect(core).toMatch(/workflow states/i);
    expect(core).toMatch(/completion transitions/i);
    expect(core).toMatch(/scope-deviation triggers/i);
    expect(core).toMatch(/semantic engineering quality/i);
    expect(core).toMatch(/test selection/i);
  });

  it("wires command assets to shared methodology references without full prompt duplication", async () => {
    const marketplace = await readFile(path.join(repoRoot, "plugin-skills", "sequential-workflow", "SKILL.md"), "utf8");
    const local = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md"), "utf8");
    expect(marketplace).toContain("methodology/core.md");
    expect(marketplace).toContain("methodology/modes/<fast|standard|rigorous>.md");
    expect(local).toContain(".claude/leanrigor/methodology/core.md");
    expect(local).toContain(".claude/leanrigor/methodology/modes/<fast|standard|rigorous>.md");
    expect(local).not.toContain("Strong Evidence");
    expect(marketplace).not.toContain("Strong Evidence");
  });

  it("installs project-local methodology from the same source material", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    for (const file of methodologyFiles) {
      const source = await readMethodology(file);
      const installed = await readFile(path.join(root, ".claude", "leanrigor", "methodology", file), "utf8");
      expect(installed).toBe(source);
    }
  });

  it("includes methodology in npm package metadata", () => {
    expect(packageJson.files).toContain("methodology/");
    expect(packageJson.files).toContain("plugin-skills/");
    expect(packageJson.files).toContain("internal-skills/");
    expect(packageJson.files).not.toContain("skills/");
  });
});

describe("deterministic methodology smoke scenarios", () => {
  it("Fast typo work stays compact", async () => {
    const state = await startFlow({ request: "Fix a typo in README", root: await tempRepo(), config: defaultConfig() });
    expect(state.mode).toBe("fast");
    expect(state.approach?.required).toBe(false);
    expect(state.plan?.phases).toHaveLength(1);
    expect(state.plan?.phases[0]?.objective).toMatch(/small low-risk/i);
    expect(state.plan?.phases[0]?.validationCommands).toContain("git diff --check");
  });

  it("Standard API consumer work exposes contract and consumer phases", async () => {
    const started = await startFlow({
      request: "Add a new optional API field and update its frontend consumer",
      root: await tempRepo(),
      config: defaultConfig()
    });
    const planned = await approveApproach(started.root, started.id, defaultConfig());

    expect(planned.mode).toBe("standard");
    const objectives = planned.plan?.phases.map((phase) => phase.objective).join("\n") ?? "";
    expect(objectives).toMatch(/public contract/i);
    expect(objectives).toMatch(/consumer/i);
    expect(objectives).toMatch(/regression coverage/i);
  });

  it("Rigorous migration on authenticated production requests isolates safeguards", async () => {
    const started = await startFlow({
      request: "Add a database migration affecting authenticated production requests",
      root: await tempRepo(),
      config: defaultConfig()
    });
    const planned = await approveApproach(started.root, started.id, defaultConfig());

    expect(planned.mode).toBe("rigorous");
    expect(planned.triage?.escalationReasons.join("\n")).toMatch(/high-risk trigger/i);
    expect(planned.plan?.phases).toHaveLength(3);
    expect(planned.plan?.phases[0]?.objective).toMatch(/migration/i);
    expect(planned.plan?.phases.every((phase) => phase.modelTier === "large")).toBe(true);
  });

  it("Debugging methodology covers intermittent duplicate-processing safeguards", async () => {
    const state = await startFlow({
      request: "Fix an intermittent duplicate-processing bug",
      root: await tempRepo(),
      config: defaultConfig()
    });
    const debugging = await readMethodology("debugging.md");

    expect(state.mode).toBe("rigorous");
    expect(debugging).toMatch(/reproduce[\s\S]*hypotheses[\s\S]*root cause/i);
    expect(debugging).toMatch(/idempotency/i);
    expect(debugging).toMatch(/regression coverage/i);
  });
});
