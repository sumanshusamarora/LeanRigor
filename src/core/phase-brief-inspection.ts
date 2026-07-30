import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeanRigorConfig } from "../config/schema.js";
import type {
  PhaseBriefInspectionQuestion,
  PhaseBriefInspectionRequest,
  PhaseBriefInspectionResult,
  PhaseBriefScopeExpansion,
  SequentialWorkflowState,
  WorkflowPhase
} from "./types.js";

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set([".git", ".leanrigor", ".codegraph", "node_modules", "dist", "coverage", "build"]);
const readableExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".graphql", ".h", ".hpp", ".html", ".java", ".js", ".json",
  ".jsx", ".kt", ".md", ".mjs", ".php", ".proto", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".vue", ".yaml", ".yml"
]);
const metadataFiles = ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"];

export interface PhaseBriefInspectionIo {
  list(directory: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  stat(file: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
  realpath(file: string): Promise<string>;
  read(file: string, maxBytes: number): Promise<Buffer>;
}

export interface PhaseBriefInspectionRun {
  request: PhaseBriefInspectionRequest;
  result: PhaseBriefInspectionResult;
}

export function phaseBriefInspectionQuestions(phase: WorkflowPhase): PhaseBriefInspectionQuestion[] {
  return [
    { id: "implementation", question: "Which files and symbols currently implement the affected behaviour?", reason: `Locate the concrete implementation boundary for ${phase.id}.` },
    { id: "tests", question: "Which tests cover the current behaviour?", reason: "Identify targeted regression and failure-path coverage." },
    { id: "contracts", question: "Which types, schemas, or public contracts constrain the change?", reason: "Preserve existing repository contracts and compatibility expectations." },
    { id: "validation", question: "Which repository-defined validation commands are available?", reason: "Use repository-owned validation rather than invented commands." },
    { id: "nearby-readonly", question: "Which nearby files may be read but should not be modified?", reason: "Separate contextual reads from the approved write boundary." },
    { id: "boundaries", question: "Are the Workflow Plan expected read and write areas still accurate?", reason: "Detect refinements or scope drift before approval." }
  ];
}

export function derivePhaseBriefInspectionRequest(
  state: SequentialWorkflowState,
  phase: WorkflowPhase,
  config: LeanRigorConfig
): PhaseBriefInspectionRequest {
  const initial = unique([
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.expectedFilesOrAreas,
    ...(state.triageRun?.evidence?.request.explicitlyNamedPaths ?? [])
  ].filter(looksLikeRepositoryPath).map(normalizeScopePath).filter((value): value is string => Boolean(value)));
  const allowedPaths = [...initial];
  const scopeExpansions: PhaseBriefScopeExpansion[] = [];

  for (const metadata of metadataFiles) {
    addExpansion(allowedPaths, scopeExpansions, metadata, "Repository metadata may define validation, language, and architecture constraints.");
  }
  if (requiresTestDiscovery(state, phase)) {
    addExpansion(allowedPaths, scopeExpansions, "tests", "Repository test layout is a bounded read-only source for coverage discovery.");
    for (const area of phase.expectedWriteAreas) {
      const normalized = normalizeScopePath(area);
      if (!normalized) continue;
      const directory = path.posix.dirname(normalized);
      addExpansion(allowedPaths, scopeExpansions, directory, `Sibling tests and contracts may constrain ${normalized}.`, normalized);
    }
  }
  for (const item of state.triageRun?.evidence?.referencedWorkItems ?? []) {
    for (const referencedPath of pathsFromText(`${item.title ?? ""}\n${item.body ?? ""}`)) {
      addExpansion(allowedPaths, scopeExpansions, referencedPath, `Referenced issue ${item.issueNumber} names this read-only path.`);
    }
  }

  return {
    workflowId: state.id,
    phaseId: phase.id,
    workflowRevision: state.approval?.workflowPlanRevision ?? state.revision,
    questions: phaseBriefInspectionQuestions(phase),
    allowedPaths: unique(allowedPaths),
    scopeExpansions,
    maxReads: config.budgets.phaseBriefInspectionMaxReads,
    maxBytes: config.budgets.phaseBriefInspectionMaxBytes,
    timeoutSeconds: config.budgets.phaseBriefInspectionTimeoutSeconds
  };
}

export async function inspectPhaseBrief(args: {
  root: string;
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  request: PhaseBriefInspectionRequest;
  io?: PhaseBriefInspectionIo;
  provider?: string;
}): Promise<PhaseBriefInspectionRun> {
  const io = args.io ?? nodeInspectionIo;
  const request = structuredClone(args.request);
  const started = Date.now();
  const deadline = started + request.timeoutSeconds * 1000;
  const root = await io.realpath(path.resolve(args.root)).catch(() => path.resolve(args.root));
  const warnings: string[] = [];
  const filesRead: string[] = [];
  const relevantFiles: string[] = [];
  const relevantSymbols: string[] = [];
  const validationCommands = new Set(args.phase.validationCommands);
  const evidence = new Map<string, string[]>();
  const candidates = await collectCandidates(root, request.allowedPaths, args.phase, io, warnings);
  let bytesRead = 0;
  let timedOut = false;

  for (let index = 0; index < candidates.length && filesRead.length < request.maxReads && bytesRead < request.maxBytes; index += 1) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const candidate = candidates[index]!;
    const remaining = request.maxBytes - bytesRead;
    if (remaining <= 0) break;
    try {
      const content = await beforeDeadline(io.read(candidate.absolute, remaining), deadline);
      if (!content) {
        timedOut = true;
        break;
      }
      const relative = slash(path.relative(root, candidate.absolute));
      const text = content.toString("utf8");
      filesRead.push(relative);
      bytesRead += content.length;
      if (!metadataFiles.includes(relative) && (candidate.score > 0 || isDirectPhasePath(relative, args.phase))) relevantFiles.push(relative);
      const symbols = symbolsFromText(text).map((symbol) => `${relative}#${symbol}`);
      relevantSymbols.push(...symbols);
      classifyEvidence(relative, text, symbols, validationCommands, evidence);
      const imports = relativeImports(text);
      for (const imported of imports) {
        const resolved = await resolveImport(root, relative, imported, io);
        if (!resolved || filesRead.includes(resolved) || candidates.some((item) => item.relative === resolved)) continue;
        addExpansion(request.allowedPaths, request.scopeExpansions, resolved, `Direct import from ${relative} is required to understand the bounded implementation contract.`, relative);
        candidates.push({ relative: resolved, absolute: path.join(root, resolved), priority: Math.max(0, candidate.priority - 1), score: candidate.score + 2 });
      }
      candidates.sort((left, right) => right.priority - left.priority || right.score - left.score || left.relative.localeCompare(right.relative));
    } catch (error) {
      warnings.push(`Could not read ${candidate.relative}: ${messageOf(error)}`);
    }
  }

  if (timedOut) warnings.push(`Inspection stopped after the ${request.timeoutSeconds}s timeout.`);
  if (filesRead.length >= request.maxReads && candidates.length > filesRead.length) warnings.push(`Inspection stopped at the ${request.maxReads}-file read limit.`);
  if (bytesRead >= request.maxBytes) warnings.push(`Inspection stopped at the ${request.maxBytes}-byte limit.`);

  const findings = request.questions.map((question) => {
    const items = evidence.get(question.id) ?? [];
    return {
      questionId: question.id,
      question: question.question,
      answer: answerFor(question.id, items, args.phase, relevantFiles, relevantSymbols, validationCommands),
      evidence: unique(items)
    };
  });
  const unresolvedQuestions = findings.filter((finding) => finding.evidence.length === 0 && ["implementation", "tests", "contracts"].includes(finding.questionId)).map((finding) => finding.question);
  const meaningfulReads = filesRead.filter((file) => file !== "package.json" && !metadataFiles.includes(file));
  const status: PhaseBriefInspectionResult["status"] = timedOut && filesRead.length === 0
    ? "failed"
    : filesRead.length === 0
      ? "unavailable"
      : unresolvedQuestions.length > 0 || timedOut || meaningfulReads.length === 0
        ? "partial"
        : "completed";

  return {
    request,
    result: {
      status,
      findings,
      filesRead,
      bytesRead,
      unresolvedQuestions,
      warnings,
      relevantFiles: unique(relevantFiles),
      relevantSymbols: unique(relevantSymbols),
      validationCommands: [...validationCommands],
      completedAt: new Date().toISOString(),
      provenance: {
        source: "deterministic-bounded-inspection",
        provider: args.provider,
        modelTier: args.phase.modelTier
      }
    }
  };
}

export async function repositoryRevision(root: string): Promise<{ baseCommit?: string; revision: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5000 });
    const commit = stdout.trim();
    if (commit) return { baseCommit: commit, revision: commit };
  } catch {
    // Non-Git fixtures still receive a deterministic inspection identity later.
  }
  return { revision: "repository-without-git-head" };
}

const nodeInspectionIo: PhaseBriefInspectionIo = {
  async list(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
  },
  async stat(file) {
    const value = await stat(file);
    return { isDirectory: value.isDirectory(), isFile: value.isFile(), size: value.size };
  },
  realpath,
  async read(file, maxBytes) {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
};

interface Candidate {
  relative: string;
  absolute: string;
  priority: number;
  score: number;
}

async function collectCandidates(
  root: string,
  allowedPaths: string[],
  phase: WorkflowPhase,
  io: PhaseBriefInspectionIo,
  warnings: string[]
): Promise<Candidate[]> {
  const candidates = new Map<string, Candidate>();
  const tokens = relevanceTokens(phase);
  for (const allowed of allowedPaths) {
    const normalized = normalizeScopePath(allowed);
    if (!normalized) continue;
    const absolute = path.resolve(root, normalized);
    if (!isWithin(root, absolute)) continue;
    const canonical = await io.realpath(absolute).catch(() => absolute);
    if (!isWithin(root, canonical)) {
      warnings.push(`Skipped ${normalized}: resolved path escapes the repository.`);
      continue;
    }
    const info = await io.stat(canonical).catch(() => undefined);
    if (!info) continue;
    if (info.isFile) {
      addCandidate(candidates, root, canonical, scorePath(normalized, tokens, phase, true), phase);
      continue;
    }
    if (info.isDirectory) await walkDirectory(root, canonical, 0, candidates, tokens, phase, io);
  }
  return [...candidates.values()]
    .filter((candidate) => candidate.score > 0 || isDirectPhasePath(candidate.relative, phase) || metadataFiles.includes(candidate.relative))
    .sort((left, right) => right.priority - left.priority || right.score - left.score || left.relative.localeCompare(right.relative))
    .slice(0, 250);
}

async function walkDirectory(
  root: string,
  directory: string,
  depth: number,
  candidates: Map<string, Candidate>,
  tokens: string[],
  phase: WorkflowPhase,
  io: PhaseBriefInspectionIo
): Promise<void> {
  if (depth > 5 || candidates.size >= 250) return;
  const entries = await io.list(directory).catch(() => []);
  for (const entry of entries) {
    if (candidates.size >= 250) return;
    if (entry.isDirectory && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (!isWithin(root, absolute)) continue;
    if (entry.isDirectory) {
      await walkDirectory(root, absolute, depth + 1, candidates, tokens, phase, io);
      continue;
    }
    if (!entry.isFile || !isReadableFile(entry.name)) continue;
    const relative = slash(path.relative(root, absolute));
    const score = scorePath(relative, tokens, phase, false);
    if (score > 0 || isDirectPhasePath(relative, phase) || metadataFiles.includes(relative)) addCandidate(candidates, root, absolute, score, phase);
  }
}

function addCandidate(candidates: Map<string, Candidate>, root: string, absolute: string, score: number, phase: WorkflowPhase): void {
  const relative = slash(path.relative(root, absolute));
  const existing = candidates.get(relative);
  const priority = inspectionPriority(relative, phase);
  if (!existing || existing.priority < priority || (existing.priority === priority && existing.score < score)) {
    candidates.set(relative, { relative, absolute, priority, score });
  }
}

function inspectionPriority(file: string, phase: WorkflowPhase): number {
  const matches = (areas: string[]) => areas.some((area) => {
    const normalized = normalizeScopePath(area);
    return normalized ? file === normalized || file.startsWith(`${normalized}/`) : false;
  });
  const test = isTestFile(file);
  // Read concrete implementation targets before broad test discovery. This
  // prevents a large test fixture from exhausting the bounded byte budget.
  if (matches(phase.expectedWriteAreas)) return test ? 3 : 5;
  if (matches(phase.expectedReadAreas)) return test ? 2 : 4;
  if (matches(phase.expectedFilesOrAreas)) return test ? 2 : 3;
  return metadataFiles.includes(file) ? 1 : 0;
}

function relevanceTokens(phase: WorkflowPhase): string[] {
  const text = [
    phase.objective,
    phase.rationale,
    ...phase.expectedReadAreas,
    ...phase.expectedWriteAreas,
    ...phase.acceptanceCriteria
  ].join(" ").toLowerCase();
  return unique((text.match(/[a-z][a-z0-9_-]{2,}/g) ?? [])
    .filter((token) => !["phase", "implement", "update", "change", "ensure", "with", "from", "that", "this", "tests", "test"].includes(token)));
}

function scorePath(file: string, tokens: string[], phase: WorkflowPhase, explicit: boolean): number {
  const lower = file.toLowerCase();
  let score = explicit ? 20 : 0;
  for (const token of tokens) if (lower.includes(token)) score += 3;
  if (isDirectPhasePath(file, phase)) score += 15;
  if (/\.(test|spec)\.[^.]+$|(^|\/)__tests__(\/|$)|^tests\//.test(lower)) score += 4;
  if (/types?|schema|contract|interface/.test(lower)) score += 3;
  if (metadataFiles.includes(file)) score += 10;
  return score;
}

function classifyEvidence(
  file: string,
  text: string,
  symbols: string[],
  validationCommands: Set<string>,
  evidence: Map<string, string[]>
): void {
  const reference = symbols[0] ?? file;
  if (isTestFile(file)) addEvidence(evidence, "tests", reference);
  else if (file !== "package.json" && !metadataFiles.includes(file)) addEvidence(evidence, "implementation", reference);
  if (/interface\s+\w+|type\s+\w+\s*=|schema|contract|openapi|graphql|proto/i.test(text) || /types?|schema|contract/.test(file.toLowerCase())) {
    addEvidence(evidence, "contracts", reference);
  }
  if (file === "package.json") {
    try {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const name of ["test", "typecheck", "lint", "build", "check"]) {
        if (scripts[name]) validationCommands.add(`npm run ${name}`);
      }
      for (const name of Object.keys(scripts).filter((name) => /test|check|lint|type|build|validate/.test(name)).slice(0, 8)) {
        validationCommands.add(`npm run ${name}`);
      }
      addEvidence(evidence, "validation", "package.json#scripts");
    } catch {
      // Malformed metadata remains a persisted warning from the read itself.
    }
  }
  addEvidence(evidence, "nearby-readonly", file);
  addEvidence(evidence, "boundaries", file);
}

function answerFor(
  questionId: string,
  items: string[],
  phase: WorkflowPhase,
  relevantFiles: string[],
  relevantSymbols: string[],
  validationCommands: Set<string>
): string {
  if (questionId === "implementation") {
    if (relevantFiles.length === 0) return `No existing implementation file was found; the approved target paths remain the bounded creation boundary for ${phase.id}.`;
    return `Current implementation evidence is concentrated in ${relevantFiles.slice(0, 6).join(", ")}${relevantSymbols.length > 0 ? `, including ${relevantSymbols.slice(0, 6).join(", ")}` : ""}.`;
  }
  if (questionId === "tests") return items.length > 0 ? `Existing coverage was found in ${items.slice(0, 6).join(", ")}.` : "No existing targeted test was found within the bounded inspection scope.";
  if (questionId === "contracts") return items.length > 0 ? `Relevant types, schemas, or contracts were found in ${items.slice(0, 6).join(", ")}.` : "No additional contract file was identified within the bounded scope.";
  if (questionId === "validation") return validationCommands.size > 0 ? `Available validation includes ${[...validationCommands].slice(0, 8).join(", ")}.` : "No executable repository validation command was discovered.";
  if (questionId === "nearby-readonly") return `Context reads are limited to ${unique(items).slice(0, 8).join(", ") || "the approved inspection paths"}; write scope remains separately bounded.`;
  return `Inspected evidence stayed within the approved paths and recorded read-only expansions; planned writes remain ${phase.expectedWriteAreas.join(", ") || phase.expectedFilesOrAreas.join(", ")}.`;
}

function symbolsFromText(text: string): string[] {
  const symbols: string[] = [];
  const pattern = /(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var|def|struct|trait)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) symbols.push(match[1]);
    if (symbols.length >= 30) break;
  }
  return unique(symbols);
}

function relativeImports(text: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of text.matchAll(pattern)) if (match[1]) imports.push(match[1]);
  return unique(imports);
}

async function resolveImport(root: string, fromFile: string, imported: string, io: PhaseBriefInspectionIo): Promise<string | undefined> {
  const base = path.resolve(root, path.dirname(fromFile), imported);
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"].map((extension) => `${base}${extension}`), ...["index.ts", "index.tsx", "index.js"].map((name) => path.join(base, name))];
  for (const candidate of candidates) {
    if (!isWithin(root, candidate)) continue;
    const info = await io.stat(candidate).catch(() => undefined);
    if (info?.isFile) return slash(path.relative(root, candidate));
  }
  return undefined;
}

function normalizeScopePath(value: string): string | undefined {
  const normalized = slash(value.trim().replace(/^\.\//, ""));
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return undefined;
  const wildcard = normalized.search(/[*?[{]/);
  const withoutGlob = wildcard >= 0 ? normalized.slice(0, wildcard) : normalized;
  const cleaned = withoutGlob.replace(/\/+$/, "");
  return cleaned && cleaned !== "." ? cleaned : undefined;
}

function looksLikeRepositoryPath(value: string): boolean {
  const normalized = slash(value.trim());
  return normalized.includes("/")
    || /(^|\/)(readme|makefile)$/i.test(normalized)
    || /\.[A-Za-z0-9]{1,12}(?:$|[*?[{])/.test(normalized);
}

function pathsFromText(text: string): string[] {
  return unique((text.match(/\b(?:src|tests?|docs?|lib|app|packages|config|scripts)\/[A-Za-z0-9._/*-]+/g) ?? []).map((value) => value.replace(/[),.;:]+$/, "")));
}

function requiresTestDiscovery(state: SequentialWorkflowState, phase: WorkflowPhase): boolean {
  const text = `${state.request} ${phase.objective} ${phase.rationale}`.toLowerCase();
  return state.triage?.task.type !== "documentation" && !/\b(documentation|docs-only|readme only)\b/.test(text);
}

function isDirectPhasePath(file: string, phase: WorkflowPhase): boolean {
  return [...phase.expectedReadAreas, ...phase.expectedWriteAreas, ...phase.expectedFilesOrAreas].some((area) => {
    const normalized = normalizeScopePath(area);
    return normalized ? file === normalized || file.startsWith(`${normalized}/`) : false;
  });
}

function isReadableFile(file: string): boolean {
  return metadataFiles.includes(file) || readableExtensions.has(path.extname(file).toLowerCase());
}

function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(file);
}

function addExpansion(paths: string[], expansions: PhaseBriefScopeExpansion[], value: string, reason: string, sourcePath?: string): void {
  const normalized = normalizeScopePath(value);
  if (!normalized || paths.includes(normalized)) return;
  paths.push(normalized);
  expansions.push({ path: normalized, reason, sourcePath, readOnly: true });
}

function addEvidence(evidence: Map<string, string[]>, key: string, value: string): void {
  evidence.set(key, unique([...(evidence.get(key) ?? []), value]));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  return Promise.race([
    operation,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), remaining))
  ]);
}

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
