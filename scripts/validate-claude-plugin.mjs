#!/usr/bin/env node
import { access, constants, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };

const root = process.cwd();
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return undefined;
  }
}

function assertRelativeInside(value, owner) {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith("./")) fail(`${owner}: path must start with ./ (${entry})`);
    const normalised = path.posix.normalize(entry);
    if (normalised.startsWith("../") || path.isAbsolute(entry)) fail(`${owner}: path escapes plugin root (${entry})`);
  }
}

async function assertExists(relativePath, label) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    fail(`${label} not found: ${relativePath}`);
  }
}

async function assertExecutable(relativePath) {
  try {
    await access(path.join(root, relativePath), constants.X_OK);
  } catch {
    fail(`Executable bit missing: ${relativePath}`);
  }
}

function extractFrontmatter(content, file) {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    fail(`${file}: missing YAML frontmatter`);
    return {};
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    fail(`${file}: unterminated YAML frontmatter`);
    return {};
  }
  const fields = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function commandFilesFrom(manifest) {
  const values = Array.isArray(manifest.commands) ? manifest.commands : [manifest.commands].filter(Boolean);
  return values.filter((entry) => typeof entry === "string" && entry.endsWith(".md")).map((entry) => entry.slice(2));
}

const marketplace = await readJson(".claude-plugin/marketplace.json");
const plugin = await readJson(".claude-plugin/plugin.json");
const buildInfo = await readJson(".claude-plugin/build-info.json");
const expectedCommands = [
  "./commands/start.md",
  "./commands/init.md",
  "./commands/plan.md",
  "./commands/status.md",
  "./commands/review.md",
  "./commands/commit.md"
];
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
  "modes/fast.md",
  "modes/standard.md",
  "modes/rigorous.md"
];

if (marketplace) {
  if (marketplace.name !== "leanrigor") fail("marketplace name must be leanrigor");
  if (!marketplace.owner?.name) fail("marketplace owner.name is required");
  const leanRigorEntry = marketplace.plugins?.find((entry) => entry.name === "leanrigor");
  if (!leanRigorEntry) fail("marketplace must list plugin named leanrigor");
  if (leanRigorEntry) {
    if (leanRigorEntry.source !== "./") fail("leanrigor marketplace source must be ./");
    if (leanRigorEntry.version !== packageJson.version) fail("marketplace version must match package.json");
  }
}

if (plugin) {
  if (plugin.name !== "leanrigor") fail("plugin name must be leanrigor");
  if (plugin.version !== packageJson.version) fail("plugin version must match package.json");
  if (JSON.stringify(plugin.commands) !== JSON.stringify(expectedCommands)) {
    fail(`plugin commands must be exactly ${expectedCommands.join(", ")}`);
  }

  if (buildInfo) {
    if (buildInfo.packageVersion !== packageJson.version) fail("build-info packageVersion must match package.json");
    if (buildInfo.pluginVersion !== packageJson.version) fail("build-info pluginVersion must match package.json");
    if (!buildInfo.gitCommit || typeof buildInfo.gitCommit !== "string") fail("build-info gitCommit is required");
  }

  const cliSource = await readFile(path.join(root, "src", "cli", "index.ts"), "utf8");
  const cliVersionMatch = cliSource.match(/program\.name\("leanrigor"\)\.description\("Adaptive rigor and model routing for AI coding agents"\)\.version\("([^"]+)"\);/);
  if (!cliVersionMatch) fail("src/cli/index.ts: could not find CLI version declaration");
  if (cliVersionMatch && cliVersionMatch[1] !== packageJson.version) fail("CLI version must match package.json");
  for (const key of ["commands", "agents", "skills", "hooks"]) {
    if (plugin[key]) assertRelativeInside(plugin[key], `plugin.${key}`);
  }
  for (const file of commandFilesFrom(plugin)) {
    await assertExists(file, "command");
    if (path.basename(file).includes("leanrigor-")) fail(`${file}: marketplace command filename must not contain leanrigor-`);
    const content = await readFile(path.join(root, file), "utf8");
    const fm = extractFrontmatter(content, file);
    if (!fm.description) fail(`${file}: command frontmatter needs description`);
    if (!fm["allowed-tools"]?.includes("AskUserQuestion")) fail(`${file}: command frontmatter must allow AskUserQuestion`);
    if (!content.includes("${CLAUDE_PLUGIN_ROOT}/bin/leanrigor")) fail(`${file}: must invoke plugin-owned runtime`);
    if (!content.includes("plugin-skills/sequential-workflow")) fail(`${file}: must load the sequential workflow skill`);
    if (!content.includes("AskUserQuestion")) fail(`${file}: must include native selector guidance`);
    if (!content.includes("Do not render an ordinary text question first")) fail(`${file}: must prohibit text question before native selector`);
  }
  const agentPaths = Array.isArray(plugin.agents) ? plugin.agents : [plugin.agents].filter(Boolean);
  for (const agentPath of agentPaths) {
    const file = agentPath.slice(2);
    await assertExists(file, "agent");
    const content = await readFile(path.join(root, file), "utf8");
    const fm = extractFrontmatter(content, file);
    if (!fm.name || !fm.description) fail(`${file}: agent frontmatter needs name and description`);
  }
}

await assertExists("hooks/hooks.json", "hook config");
await assertExists("hooks/protect-git.sh", "hook script");
await assertExecutable("hooks/protect-git.sh");
await assertExists("bin/leanrigor", "plugin launcher");
await assertExecutable("bin/leanrigor");
await assertExists("runtime/leanrigor-cli.js", "bundled runtime");
await assertExists("plugin-skills/sequential-workflow/SKILL.md", "plugin skill");
for (const file of methodologyFiles) await assertExists(`methodology/${file}`, "methodology file");
try {
  await access(path.join(root, "skills"));
  fail("root skills/ directory must not exist because Claude exposes it as marketplace commands");
} catch (error) {
  if (error.code !== "ENOENT") fail(`could not inspect root skills/ directory: ${error.message}`);
}

const hooks = await readJson("hooks/hooks.json");
if (hooks) {
  const hookText = JSON.stringify(hooks);
  if (!hookText.includes("${CLAUDE_PLUGIN_ROOT}/hooks/protect-git.sh")) fail("hook must resolve protect-git.sh through CLAUDE_PLUGIN_ROOT");
}

const marketplaceWorkflowSkill = await readFile(path.join(root, "plugin-skills", "sequential-workflow", "SKILL.md"), "utf8");
const marketplaceWorkflowFm = extractFrontmatter(marketplaceWorkflowSkill, "plugin-skills/sequential-workflow/SKILL.md");
if (!marketplaceWorkflowFm["allowed-tools"]?.includes("AskUserQuestion")) fail("marketplace workflow skill must allow AskUserQuestion");
if (!marketplaceWorkflowSkill.includes("methodology/core.md")) fail("marketplace workflow skill must reference shared methodology/core.md");
if (!marketplaceWorkflowSkill.includes("methodology/modes/<fast|standard|rigorous>.md")) fail("marketplace workflow skill must reference mode overlays");
if (!marketplaceWorkflowSkill.includes("mandatory whenever the tool is available")) fail("marketplace workflow skill must require AskUserQuestion when available");
if (!/same\s+assistant\s+turn/.test(marketplaceWorkflowSkill)) fail("marketplace workflow skill must require same-turn AskUserQuestion selectors");
if (!marketplaceWorkflowSkill.includes("\"multiSelect\": false")) fail("marketplace workflow skill must document AskUserQuestion selector payload shape");
if (!marketplaceWorkflowSkill.includes("genuinely unavailable")) fail("marketplace workflow skill must restrict text fallback to genuine AskUserQuestion unavailability");
if (!marketplaceWorkflowSkill.includes("Do not use `ExitPlanMode` as a substitute")) fail("marketplace workflow skill must prohibit ExitPlanMode as LeanRigor approval");
if (!marketplaceWorkflowSkill.includes("decision.question") || !marketplaceWorkflowSkill.includes("decision.options")) fail("marketplace workflow skill must render the normalized persisted decision");
if (!marketplaceWorkflowSkill.includes("automaticallyPermitted")) fail("marketplace workflow skill must distinguish automatic operations from decisions");
if (!marketplaceWorkflowSkill.includes("flow phase-result")) fail("marketplace workflow skill must use persisted phase results");
if (!/Never call `AskUserQuestion` without a\s+current `decision`/.test(marketplaceWorkflowSkill)) fail("marketplace workflow skill must prohibit stale question presentation");
for (const option of ["Approve approach and create plan", "Add constraints to workflow strategy", "View workflow details", "Cancel workflow"]) {
  if (!marketplaceWorkflowSkill.includes(option)) fail(`marketplace workflow skill must document post-triage option: ${option}`);
}
if (!marketplaceWorkflowSkill.includes("No implementation has started")) fail("marketplace workflow skill must state that no implementation has started at the approach gate");
if (!/Do not end the\s+turn\s+from raw `flow start` JSON/.test(marketplaceWorkflowSkill)) fail("marketplace workflow skill must prohibit report-only flow-start handling");
for (const file of methodologyFiles.filter((file) => !file.startsWith("modes/"))) {
  if (!marketplaceWorkflowSkill.includes(`methodology/${file}`)) fail(`marketplace workflow skill must reference methodology/${file}`);
}

const localWorkflow = await readFile(path.join(root, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md"), "utf8");
if (!localWorkflow.includes(".claude/leanrigor/methodology/core.md")) fail("project-local workflow reference must use installed methodology path");
if (!localWorkflow.includes(".claude/leanrigor/methodology/modes/<fast|standard|rigorous>.md")) fail("project-local workflow reference must use installed mode overlays");
if (!localWorkflow.includes("decision.question") || !localWorkflow.includes("decision.options")) fail("project-local workflow must render the normalized persisted decision");
if (!/same\s+assistant\s+turn/.test(localWorkflow)) fail("project-local workflow must require same-turn AskUserQuestion selectors");
if (!localWorkflow.includes("genuinely unavailable")) fail("project-local workflow must restrict text fallback to genuine AskUserQuestion unavailability");
if (!localWorkflow.includes("ExitPlanMode")) fail("project-local workflow must prohibit ExitPlanMode as LeanRigor approval");
if (!localWorkflow.includes("automaticallyPermitted")) fail("project-local workflow must distinguish automatic operations from decisions");
if (!localWorkflow.includes("flow phase-result")) fail("project-local workflow must use persisted phase results");
if (!localWorkflow.includes("Never call `AskUserQuestion` without a")) fail("project-local workflow must prohibit stale question presentation");
for (const option of ["Approve approach and create plan", "Add constraints to workflow strategy", "View workflow details", "Cancel workflow"]) {
  if (!localWorkflow.includes(option)) fail(`project-local workflow must document post-triage option: ${option}`);
}
if (!localWorkflow.includes("No implementation has started")) fail("project-local workflow must state that no implementation has started at the approach gate");
if (!/Do not end the\s+turn\s+from raw `flow start` JSON/.test(localWorkflow)) fail("project-local workflow must prohibit report-only flow-start handling");

try {
  const runtime = await stat(path.join(root, "runtime", "leanrigor-cli.js"));
  if (runtime.size < 10000) fail("bundled runtime is unexpectedly small");
} catch {
  // already reported by assertExists
}

let claude = spawnSync("claude", ["plugin", "validate", ".", "--strict"], { cwd: root, encoding: "utf8" });
if (claude.status !== 0 && /unknown option ['"]?--strict/.test(`${claude.stdout}\n${claude.stderr}`)) {
  warn("Installed Claude CLI does not support --strict; retried plugin validation without it.");
  claude = spawnSync("claude", ["plugin", "validate", "."], { cwd: root, encoding: "utf8" });
}
if (claude.error && claude.error.code === "ENOENT") {
  warn("Claude CLI not found; skipped official `claude plugin validate . --strict`.");
} else if (claude.status !== 0) {
  fail(`claude plugin validate failed:\n${claude.stdout}\n${claude.stderr}`);
}

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}
console.log("Claude plugin validation passed.");
