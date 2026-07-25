#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staged = process.argv.includes("--staged");

const distributablePrefixes = [
  "commands/",
  "agents/",
  "hooks/",
  "bin/",
  "plugin-skills/",
  "methodology/",
  "src/adapters/claude/plugin/",
  ".claude-plugin/",
  "runtime/",
];

const versionFiles = new Set([
  "package.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "src/cli/index.ts",
]);

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitSafe(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function listChangedFiles() {
  if (staged) {
    const out = gitSafe(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    try {
      git(["fetch", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`]);
    } catch {
      // best effort; continue with local refs
    }
    const out = gitSafe(["diff", "--name-only", `origin/${baseRef}...HEAD`, "--diff-filter=ACMR"]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  const out = gitSafe(["diff", "--name-only", "HEAD~1..HEAD", "--diff-filter=ACMR"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

const changed = listChangedFiles();
const distributableChanged = changed.filter((file) => distributablePrefixes.some((prefix) => file.startsWith(prefix)));
if (distributableChanged.length === 0) {
  console.log("No distributable plugin asset changes detected.");
  process.exit(0);
}

const versionFileChanged = changed.some((file) => versionFiles.has(file));
if (versionFileChanged) {
  console.log("Distributable plugin assets changed and version files were updated.");
  process.exit(0);
}

console.error("Distributable plugin assets changed without a version update.");
console.error("Changed assets:");
for (const file of distributableChanged) {
  console.error(`- ${file}`);
}
console.error("Run `npm run version:dev` before committing.");
process.exit(1);
