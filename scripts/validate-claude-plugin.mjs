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
  if (!content.startsWith("---\n")) {
    fail(`${file}: missing YAML frontmatter`);
    return {};
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) {
    fail(`${file}: unterminated YAML frontmatter`);
    return {};
  }
  const fields = {};
  for (const line of content.slice(4, end).split("\n")) {
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
  for (const key of ["commands", "agents", "skills", "hooks"]) {
    if (plugin[key]) assertRelativeInside(plugin[key], `plugin.${key}`);
  }
  for (const file of commandFilesFrom(plugin)) {
    await assertExists(file, "command");
    const content = await readFile(path.join(root, file), "utf8");
    const fm = extractFrontmatter(content, file);
    if (!fm.description) fail(`${file}: command frontmatter needs description`);
    if (!content.includes("${CLAUDE_PLUGIN_ROOT}/bin/leanrigor")) fail(`${file}: must invoke plugin-owned runtime`);
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

const hooks = await readJson("hooks/hooks.json");
if (hooks) {
  const hookText = JSON.stringify(hooks);
  if (!hookText.includes("${CLAUDE_PLUGIN_ROOT}/hooks/protect-git.sh")) fail("hook must resolve protect-git.sh through CLAUDE_PLUGIN_ROOT");
}

try {
  const runtime = await stat(path.join(root, "runtime", "leanrigor-cli.js"));
  if (runtime.size < 10000) fail("bundled runtime is unexpectedly small");
} catch {
  // already reported by assertExists
}

const claude = spawnSync("claude", ["plugin", "validate", ".", "--strict"], { cwd: root, encoding: "utf8" });
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
