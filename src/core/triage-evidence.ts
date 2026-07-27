import { execFile } from "node:child_process";
import { access, constants, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeanRigorConfig } from "../config/schema.js";
import type { TriageEvidencePacket, TriageFinding, TriageOutput, TriageQuestion, TriageSignalValue } from "./types.js";
import { resolveReferencedWorkItems, type WorkItemResolver } from "./work-item-resolver.js";

const execFileAsync = promisify(execFile);
const MAX_NAMED_PATHS = 12;
const MAX_MANIFEST_BYTES = 24_000;

const TASK_TERMS: Array<[TriageOutput["task"]["type"], RegExp]> = [
  ["documentation", /\b(readme|docs?|documentation|copy|typo|label|text change)\b/i],
  ["bug", /\b(bug|fix|error|regression|broken|fails?|failure)\b/i],
  ["refactor", /\b(refactor|cleanup|restructure|rename)\b/i],
  ["investigation", /\b(investigate|diagnose|root cause|analysis|read-only)\b/i],
  ["maintenance", /\b(upgrade|dependency|maintenance|chore|config)\b/i],
  ["feature", /\b(add|implement|create|support|feature)\b/i]
];

const SIGNAL_PATTERNS: Record<keyof TriageEvidencePacket["changeSignals"], RegExp | undefined> = {
  taskType: undefined,
  namedBoundaries: undefined,
  publicContract: /\b(public api|public contract|api contract|breaking api|graphql schema|openapi|sdk)\b/i,
  schemaChange: /\b(schema|contract|graphql|openapi|protobuf|migration)\b/i,
  migration: /\b(migration|migrate|database schema|db schema|prisma migrate)\b/i,
  security: /\b(auth|authenticated|authentication|authorization|authorisation|permission|secret|credential|encryption|privacy|compliance)\b/i,
  concurrency: /\b(concurrency|race condition|parallel|locking|duplicate-processing|distributed consistency)\b/i,
  destructiveOperation: /\b(delete data|data deletion|drop table|truncate|destructive|irreversible)\b/i,
  productionInfrastructure: /\b(production|deployment|infrastructure|terraform|kubernetes|helm|cloudformation)\b/i,
  dataIntegrity: /\b(data integrity|financial calculation|payment|billing|ledger|migration|delete data|data deletion)\b/i,
  externalIntegration: /\b(webhook|external api|third-party|integration|oauth|stripe|slack|github app)\b/i
};

export async function collectTriageEvidence(args: {
  request: string;
  root: string;
  config: LeanRigorConfig;
  workItemResolver?: WorkItemResolver;
}): Promise<TriageEvidencePacket> {
  const root = path.resolve(args.root);
  const request = args.request;
  const findings: TriageFinding[] = [];
  const namedPaths = explicitPaths(request).slice(0, MAX_NAMED_PATHS);
  const referencedWorkItems = await resolveReferencedWorkItems({ request, root, resolver: args.workItemResolver });
  const issueText = referencedWorkItems.map((item) => [item.title, item.body].filter(Boolean).join("\n\n")).join("\n\n");
  const evidenceText = [request, issueText].filter(Boolean).join("\n\n");
  const taskIntentText = [request, ...referencedWorkItems.map((item) => item.title).filter(Boolean)].join("\n\n");
  const manifest = await readPackageJson(root);
  const languages = await detectLanguages(root, manifest);
  const packageManager = await detectPackageManager(root, manifest);
  const projectType = detectProjectType(manifest, languages);
  const hasTests = await hasAnyPath(root, ["tests", "test", "__tests__", "vitest.config.ts", "jest.config.js", "jest.config.ts", "package.json"]);
  const hasMigrations = await hasAnyPath(root, ["migrations", "db/migrations", "database/migrations", "prisma/migrations"]);
  const hasInfrastructure = await hasAnyPath(root, ["infra", "infrastructure", "terraform", ".github/workflows"]);
  const taskType = detectTaskType(taskIntentText);
  const namedBoundaries = unique([
    ...namedPaths.map((value) => value.split("/")[0] ?? value),
    ...boundaryTerms(evidenceText)
  ]).slice(0, 12);

  add(findings, "request.text", request.trim().length > 0, "verified", "user request supplied");
  for (const item of referencedWorkItems) {
    const prefix = `workItem.${item.source}.${item.issueNumber}`;
    add(findings, `${prefix}.contentStatus`, item.contentStatus, item.contentStatus === "unavailable" ? "unknown" : "verified", item.failureReason ?? "referenced work item lookup");
    if (item.repository) add(findings, `${prefix}.repository`, item.repository, "verified", "repository identity for referenced work item");
    if (item.title) add(findings, `${prefix}.title`, item.title, "verified", "referenced issue title");
    if (item.acceptanceCriteria && item.acceptanceCriteria.length > 0) add(findings, `${prefix}.acceptanceCriteria`, item.acceptanceCriteria, "verified", "referenced issue acceptance criteria");
    addIssueSectionFindings(findings, prefix, item.body ?? "");
  }
  if (namedPaths.length > 0) add(findings, "request.explicitlyNamedPaths", namedPaths, "verified", "path-like tokens appeared in the request");
  if (taskType) add(findings, "taskType", taskType, "inferred", "request keyword classification");
  if (packageManager) add(findings, "repository.packageManager", packageManager, "verified", "package manifest or lockfile");
  if (projectType) add(findings, "repository.projectType", projectType, "inferred", "bounded package manifest inspection");
  add(findings, "repository.languages", languages, languages.length > 0 ? "inferred" : "unknown", "bounded repository metadata inspection");
  add(findings, "repository.hasTests", hasTests, hasTests === "unknown" ? "unknown" : "verified", "bounded test path checks");
  add(findings, "repository.hasMigrations", hasMigrations, hasMigrations === "unknown" ? "unknown" : "verified", "bounded migration path checks");
  add(findings, "repository.hasInfrastructure", hasInfrastructure, hasInfrastructure === "unknown" ? "unknown" : "verified", "bounded infrastructure path checks");

  const requestOnlyDocs = taskType === "documentation" && namedPaths.every((candidate) => /(^|\/)(readme|docs?|changelog|.*\.md$)/i.test(candidate));
  const signals = Object.fromEntries(Object.entries(SIGNAL_PATTERNS).flatMap(([key, pattern]) => {
    if (!pattern) return [];
    const matched = pattern.test(evidenceText);
    const value: TriageSignalValue = matched ? true : requestOnlyDocs ? false : "unknown";
    add(findings, `changeSignals.${key}`, value, matched ? "verified" : requestOnlyDocs ? "inferred" : "unknown", matched ? "explicit request or work-item terminology" : requestOnlyDocs ? "documentation-only request" : "not resolved by bounded evidence");
    return [[key, value]];
  })) as Omit<TriageEvidencePacket["changeSignals"], "taskType" | "namedBoundaries">;

  const pathFindings = await inspectNamedPaths(root, namedPaths);
  findings.push(...pathFindings);
  const gitFindings = await gitMetadata(root);
  findings.push(...gitFindings);

  const unresolvedQuestions = unresolvedFromSignals(signals, taskType, namedPaths, referencedWorkItems.some((item) => item.contentStatus === "resolved"));
  return {
    version: 1,
    request: {
      text: request,
      referencedIssue: request.match(/#(\d+)/)?.[0],
      explicitlyNamedPaths: namedPaths
    },
    referencedWorkItems: referencedWorkItems.length > 0 ? referencedWorkItems : undefined,
    repository: {
      root,
      languages,
      packageManager,
      projectType,
      hasTests,
      hasMigrations,
      hasInfrastructure
    },
    changeSignals: {
      taskType,
      namedBoundaries,
      ...signals
    },
    deterministicFindings: findings,
    unresolvedQuestions
  };
}

export function materialUnknowns(evidence: TriageEvidencePacket): string[] {
  const material: Array<keyof TriageEvidencePacket["changeSignals"]> = [
    "publicContract",
    "schemaChange",
    "migration",
    "security",
    "concurrency",
    "destructiveOperation",
    "productionInfrastructure",
    "dataIntegrity",
    "externalIntegration"
  ];
  return material.filter((key) => evidence.changeSignals[key] === "unknown");
}

export function explicitRigorousTriggers(evidence: TriageEvidencePacket): string[] {
  const signals = evidence.changeSignals;
  const triggers = [
    signals.migration === true ? "migration" : undefined,
    signals.security === true ? "security" : undefined,
    signals.publicContract === true ? "public contract" : undefined,
    signals.schemaChange === true ? "schema change" : undefined,
    signals.concurrency === true ? "concurrency" : undefined,
    signals.destructiveOperation === true ? "destructive operation" : undefined,
    signals.productionInfrastructure === true ? "production infrastructure" : undefined,
    signals.dataIntegrity === true ? "data integrity" : undefined
  ].filter((value): value is string => Boolean(value));
  return unique(triggers);
}

function explicitPaths(request: string): string[] {
  const values = new Set<string>();
  for (const match of request.matchAll(/`([^`]+)`/g)) addPathCandidate(values, match[1] ?? "");
  for (const token of request.split(/\s+/)) addPathCandidate(values, token);
  return [...values].sort();
}

function addPathCandidate(values: Set<string>, raw: string): void {
  const cleaned = raw.trim().replace(/[),.;:]+$/g, "").replace(/^["']|["']$/g, "");
  if (!cleaned || cleaned.startsWith("-") || path.isAbsolute(cleaned) || cleaned.includes("..")) return;
  if (/^readme$/i.test(cleaned)) {
    values.add("README.md");
    return;
  }
  if (!/[/.]/.test(cleaned)) return;
  if (/^(https?:|app:|file:)/i.test(cleaned)) return;
  if (/^[A-Za-z0-9_.@/-]+$/.test(cleaned)) values.add(cleaned.replace(/^\.\//, ""));
}

function detectTaskType(request: string): TriageOutput["task"]["type"] | undefined {
  return TASK_TERMS.find(([, pattern]) => pattern.test(request))?.[0];
}

function boundaryTerms(request: string): string[] {
  const boundaries = [
    "api",
    "auth",
    "payments",
    "database",
    "schema",
    "workflow state",
    "workflow",
    "planning",
    "completion gate",
    "evidence gate",
    "completion evidence",
    "validation evidence",
    "validation",
    "review policy",
    "tests",
    "frontend",
    "backend",
    "cli",
    "docs",
    "infra"
  ];
  const lower = request.toLowerCase().replace(/[-_]/g, " ");
  const matched = boundaries.filter((term) => lower.includes(term));
  if (lower.includes("completion evidence gate") && !matched.includes("completion gate")) matched.push("completion gate");
  if (/\btest(?:s|ing)?\b/.test(lower) && !matched.includes("tests")) matched.push("tests");
  return matched;
}

async function detectLanguages(root: string, manifest?: Record<string, unknown>): Promise<string[]> {
  const languages = new Set<string>();
  if (manifest) {
    languages.add("JavaScript/TypeScript");
  }
  if (await exists(path.join(root, "tsconfig.json"))) languages.add("TypeScript");
  if (await exists(path.join(root, "pyproject.toml"))) languages.add("Python");
  if (await exists(path.join(root, "go.mod"))) languages.add("Go");
  if (await exists(path.join(root, "Cargo.toml"))) languages.add("Rust");
  return [...languages].sort();
}

async function detectPackageManager(root: string, manifest?: Record<string, unknown>): Promise<string | undefined> {
  const declared = typeof manifest?.packageManager === "string" ? manifest.packageManager : undefined;
  if (declared?.startsWith("pnpm@") || await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (declared?.startsWith("yarn@") || await exists(path.join(root, "yarn.lock"))) return "yarn";
  if (declared?.startsWith("bun@") || await exists(path.join(root, "bun.lock")) || await exists(path.join(root, "bun.lockb"))) return "bun";
  if (declared?.startsWith("npm@") || await exists(path.join(root, "package-lock.json"))) return "npm";
  return manifest ? "npm" : undefined;
}

function detectProjectType(manifest: Record<string, unknown> | undefined, languages: string[]): string | undefined {
  if (!manifest) return languages[0];
  const deps = { ...objectValue(manifest.dependencies), ...objectValue(manifest.devDependencies) };
  if ("vite" in deps) return "Vite application or library";
  if ("commander" in deps) return "Node CLI";
  if ("next" in deps) return "Next.js application";
  return "Node package";
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  const file = path.join(root, "package.json");
  try {
    const stats = await lstat(file);
    if (stats.size > MAX_MANIFEST_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function hasAnyPath(root: string, candidates: string[]): Promise<TriageSignalValue> {
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) return true;
  }
  return false;
}

async function inspectNamedPaths(root: string, namedPaths: string[]): Promise<TriageFinding[]> {
  const findings: TriageFinding[] = [];
  for (const rel of namedPaths.slice(0, MAX_NAMED_PATHS)) {
    try {
      const stats = await lstat(path.join(root, rel));
      add(findings, `path.${rel}`, stats.isDirectory() ? "directory" : "file", "verified", "explicitly named path exists");
    } catch {
      add(findings, `path.${rel}`, "unknown", "unknown", "explicitly named path was not found by bounded lstat");
    }
  }
  return findings;
}

async function gitMetadata(root: string): Promise<TriageFinding[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8", timeout: 2_000, maxBuffer: 64_000 }) as { stdout: string };
    const files = stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean).slice(0, 20);
    return files.length > 0
      ? [{ key: "git.status.changedFiles", value: files, confidence: "verified", source: "git status --porcelain bounded metadata" }]
      : [{ key: "git.status.changedFiles", value: [], confidence: "verified", source: "git status --porcelain bounded metadata" }];
  } catch {
    return [{ key: "git.status.changedFiles", value: "unknown", confidence: "unknown", source: "git status metadata unavailable" }];
  }
}

function unresolvedFromSignals(signals: Omit<TriageEvidencePacket["changeSignals"], "taskType" | "namedBoundaries">, taskType: TriageOutput["task"]["type"] | undefined, namedPaths: string[], hasResolvedWorkItem: boolean): TriageQuestion[] {
  if (taskType === "documentation") return [];
  return Object.entries(signals)
    .filter(([, value]) => value === "unknown")
    .slice(0, hasResolvedWorkItem ? 2 : 4)
    .map(([key]) => ({
      id: `triage-${key}`,
      question: `Does the request affect ${key.replace(/[A-Z]/g, (value) => ` ${value.toLowerCase()}`)}?`,
      reason: "This unresolved material risk can change Fast eligibility or escalation.",
      allowedPaths: namedPaths
    }));
}

function add(findings: TriageFinding[], key: string, value: TriageFinding["value"], confidence: TriageFinding["confidence"], source: string): void {
  findings.push({ key, value, confidence, source });
}

function addIssueSectionFindings(findings: TriageFinding[], prefix: string, body: string): void {
  const sections = [
    ["problem", /problem/i],
    ["goal", /goal/i],
    ["desiredBehavior", /desired behaviou?r/i],
    ["safetyCompatibility", /safety|compatibility/i],
    ["exclusions", /exclusions?|non-goals?/i]
  ] as const;
  for (const [name, pattern] of sections) {
    const value = sectionText(body, pattern);
    if (value) add(findings, `${prefix}.${name}`, value, "verified", `referenced issue ${name} section`);
  }
}

function sectionText(body: string, headingPattern: RegExp): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line.replace(/^#+\s*/, "")));
  if (start < 0) return undefined;
  const collected: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,6}\s+\S/.test(line) && collected.length > 0) break;
    if (line) collected.push(line.replace(/^[-*]\s+/, ""));
    if (collected.join(" ").length > 500) break;
  }
  const text = collected.join(" ").slice(0, 500).trim();
  return text || undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function exists(file: string): Promise<boolean> {
  return access(file, constants.F_OK).then(() => true).catch(() => false);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
