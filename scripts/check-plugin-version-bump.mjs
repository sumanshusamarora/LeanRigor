#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  "src/",
  ".claude-plugin/",
  "runtime/",
];
const distributableIgnore = new Set([
  ".claude-plugin/build-info.json",
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

function ensureBaseRef(baseRef) {
  try {
    git(["fetch", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`]);
  } catch {
    console.warn(`WARN: failed to fetch origin/${baseRef}; using existing local refs for version bump check.`);
  }
}

function listChangedFiles() {
  if (staged) {
    const out = gitSafe(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    ensureBaseRef(baseRef);
    const out = gitSafe(["diff", "--name-only", `origin/${baseRef}...HEAD`, "--diff-filter=ACMR"]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  const hasWorkingTreeChanges = gitSafe(["status", "--porcelain"]).length > 0;
  if (hasWorkingTreeChanges) {
    const out = gitSafe(["diff", "--name-only", "HEAD", "--diff-filter=ACMR"]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  const out = process.env.GITHUB_ACTIONS
    ? gitSafe(["diff", "--name-only", "HEAD~1..HEAD", "--diff-filter=ACMR"])
    : gitSafe(["diff", "--name-only", "HEAD", "--diff-filter=ACMR"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function readPackageVersionFromContent(content, sourceLabel = "package.json") {
  const parsed = JSON.parse(content);
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${sourceLabel} must contain a non-empty 'version' string`);
  }
  return parsed.version;
}

function readPackageVersionFromGitRef(ref) {
  try {
    const content = git(["show", `${ref}:package.json`]);
    return readPackageVersionFromContent(content, `${ref}:package.json`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read package.json from git ref '${ref}': ${message}`, { cause: error });
  }
}

function readStagedPackageVersion() {
  const content = git(["show", ":package.json"]);
  return readPackageVersionFromContent(content, "staged package.json");
}

function readWorkingTreePackageVersion() {
  const content = readFileSync(path.join(root, "package.json"), "utf8");
  return readPackageVersionFromContent(content, "working tree package.json");
}

function resolveVersionPair() {
  if (staged) {
    return {
      previous: readPackageVersionFromGitRef("HEAD"),
      current: readStagedPackageVersion(),
      baselineLabel: "HEAD",
    };
  }

  const baseRef = process.env.GITHUB_BASE_REF;
  if (baseRef) {
    ensureBaseRef(baseRef);
    let mergeBase;
    try {
      mergeBase = git(["merge-base", "HEAD", `origin/${baseRef}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve merge-base with origin/${baseRef}: ${message}`, { cause: error });
    }
    if (!mergeBase) {
      throw new Error(`Failed to resolve merge-base for origin/${baseRef}: empty result`);
    }
    return {
      previous: readPackageVersionFromGitRef(mergeBase),
      current: readPackageVersionFromGitRef("HEAD"),
      baselineLabel: `${baseRef} merge-base (${mergeBase.slice(0, 12)})`,
    };
  }

  const hasWorkingTreeChanges = gitSafe(["status", "--porcelain"]).length > 0;
  if (hasWorkingTreeChanges) {
    return {
      previous: readPackageVersionFromGitRef("HEAD"),
      current: readWorkingTreePackageVersion(),
      baselineLabel: "HEAD",
    };
  }

  return {
    previous: readPackageVersionFromGitRef("HEAD~1"),
    current: readPackageVersionFromGitRef("HEAD"),
    baselineLabel: "HEAD~1",
  };
}

const changed = listChangedFiles();
const distributableChanged = changed.filter((file) =>
  distributablePrefixes.some((prefix) => file.startsWith(prefix))
  && !distributableIgnore.has(file),
);
if (distributableChanged.length === 0) {
  console.log("No distributable plugin asset changes detected.");
  process.exit(0);
}

const { previous, current, baselineLabel } = resolveVersionPair();
if (previous !== current) {
  console.log(`Distributable plugin assets changed and package version was bumped (${baselineLabel}: ${previous} -> current: ${current}).`);
  process.exit(0);
}

console.error("Distributable plugin assets changed without a package version bump. Run `npm run version:dev` before committing.");
console.error("Changed assets:");
for (const file of distributableChanged) {
  console.error(`- ${file}`);
}
console.error("Run `npm run version:dev` before committing.");
process.exit(1);
