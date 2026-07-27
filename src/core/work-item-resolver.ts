import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReferencedWorkItem } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_ISSUE_BODY_BYTES = 32_000;
const GITHUB_API_TIMEOUT_MS = 5_000;

export interface WorkItemReference {
  source: "github-issue";
  repository?: string;
  issueNumber: number;
  raw: string;
}

export interface WorkItemResolver {
  resolve(reference: WorkItemReference, root: string): Promise<ReferencedWorkItem>;
}

export class GithubIssueWorkItemResolver implements WorkItemResolver {
  async resolve(reference: WorkItemReference, root: string): Promise<ReferencedWorkItem> {
    const repository = reference.repository ?? await resolveGithubRepository(root);
    if (!repository) {
      return unavailable(reference, "No GitHub repository remote could be resolved.");
    }

    const base = {
      source: "github-issue" as const,
      repository,
      issueNumber: reference.issueNumber,
      truncated: false
    };

    const gh = await fetchWithGh(repository, reference.issueNumber, root);
    if (gh.status === "resolved") {
      return {
        ...base,
        ...boundIssueContent(gh.issue.title, gh.issue.body ?? ""),
        url: gh.issue.url,
        contentStatus: "resolved",
        retrievedAt: new Date().toISOString()
      };
    }

    const api = await fetchWithGithubApi(repository, reference.issueNumber);
    if (api.status === "resolved") {
      return {
        ...base,
        ...boundIssueContent(api.issue.title, api.issue.body ?? ""),
        url: api.issue.html_url,
        contentStatus: "resolved",
        retrievedAt: new Date().toISOString()
      };
    }

    return {
      ...base,
      contentStatus: "unavailable",
      truncated: false,
      failureReason: safeFailure([gh.failureReason, api.failureReason].filter(Boolean).join("; ") || "GitHub issue lookup unavailable.")
    };
  }
}

export function extractWorkItemReferences(request: string): WorkItemReference[] {
  const refs = new Map<string, WorkItemReference>();
  const add = (reference: WorkItemReference) => refs.set(`${reference.repository ?? ""}#${reference.issueNumber}`, reference);

  for (const match of request.matchAll(/\bgithub\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\b/gi)) {
    add({ source: "github-issue", repository: match[1], issueNumber: Number(match[2]), raw: match[0] });
  }

  for (const match of request.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)\b/g)) {
    add({ source: "github-issue", repository: match[1], issueNumber: Number(match[2]), raw: match[0] });
  }

  const contextualIssue = /\b(?:github\s+)?(?:issues?|pull request|pr)\s*#([1-9]\d*)\b/i;
  const match = request.match(contextualIssue);
  if (match) add({ source: "github-issue", issueNumber: Number(match[1]), raw: match[0] });

  return [...refs.values()].slice(0, 3);
}

export async function resolveReferencedWorkItems(args: {
  request: string;
  root: string;
  resolver?: WorkItemResolver;
}): Promise<ReferencedWorkItem[]> {
  const references = extractWorkItemReferences(args.request);
  if (references.length === 0) return [];
  const resolver = args.resolver ?? new GithubIssueWorkItemResolver();
  return Promise.all(references.map((reference) => resolver.resolve(reference, args.root)));
}

async function resolveGithubRepository(root: string): Promise<string | undefined> {
  const remotes = await gitRemoteLines(root);
  const candidates = ["origin", "upstream"];
  for (const name of candidates) {
    const repo = repositoryFromRemote(remotes.find((line) => line.startsWith(`${name}\t`)) ?? "");
    if (repo) return repo;
  }
  for (const remote of remotes) {
    const repo = repositoryFromRemote(remote);
    if (repo) return repo;
  }
  return undefined;
}

async function gitRemoteLines(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "-v"], { cwd: root, encoding: "utf8", timeout: 2_000, maxBuffer: 64_000 }) as { stdout: string };
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function repositoryFromRemote(line: string): string | undefined {
  const value = line.split(/\s+/)[1] ?? line;
  const https = value.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:$|[\s#?])/i)?.[1];
  return https?.replace(/\.git$/i, "");
}

async function fetchWithGh(repository: string, issueNumber: number, root: string): Promise<{ status: "resolved"; issue: { title: string; body?: string; url?: string } } | { status: "unavailable"; failureReason: string }> {
  try {
    const { stdout } = await execFileAsync("gh", ["issue", "view", String(issueNumber), "--repo", repository, "--json", "title,body,url"], {
      cwd: root,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 128_000
    }) as { stdout: string };
    const issue = JSON.parse(stdout) as { title?: unknown; body?: unknown; url?: unknown };
    if (typeof issue.title === "string") {
      return { status: "resolved", issue: { title: issue.title, body: typeof issue.body === "string" ? issue.body : "", url: typeof issue.url === "string" ? issue.url : undefined } };
    }
    return { status: "unavailable", failureReason: "gh returned issue data without a title." };
  } catch (error) {
    return { status: "unavailable", failureReason: `gh issue lookup failed: ${safeFailure(messageOf(error))}` };
  }
}

async function fetchWithGithubApi(repository: string, issueNumber: number): Promise<{ status: "resolved"; issue: { title: string; body?: string; html_url?: string } } | { status: "unavailable"; failureReason: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, {
      signal: controller.signal,
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "LeanRigor" }
    });
    if (!response.ok) return { status: "unavailable", failureReason: `GitHub API returned HTTP ${response.status}.` };
    const issue = await response.json() as { title?: unknown; body?: unknown; html_url?: unknown };
    if (typeof issue.title === "string") {
      return { status: "resolved", issue: { title: issue.title, body: typeof issue.body === "string" ? issue.body : "", html_url: typeof issue.html_url === "string" ? issue.html_url : undefined } };
    }
    return { status: "unavailable", failureReason: "GitHub API returned issue data without a title." };
  } catch (error) {
    return { status: "unavailable", failureReason: `GitHub API lookup failed: ${safeFailure(messageOf(error))}` };
  } finally {
    clearTimeout(timeout);
  }
}

function boundIssueContent(title: string, body: string): Pick<ReferencedWorkItem, "title" | "body" | "acceptanceCriteria" | "truncated"> {
  const encoded = Buffer.from(body, "utf8");
  const truncated = encoded.byteLength > MAX_ISSUE_BODY_BYTES;
  const boundedBody = truncated ? encoded.subarray(0, MAX_ISSUE_BODY_BYTES).toString("utf8") : body;
  return {
    title: title.trim(),
    body: boundedBody.trim(),
    acceptanceCriteria: extractAcceptanceCriteria(boundedBody),
    truncated
  };
}

function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /acceptance criteria|initial acceptance criteria|criteria/i.test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) {
      if (items.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s+\S/.test(line) && items.length > 0) break;
    const item = line.match(/^[-*]\s+(.+)/)?.[1] ?? line.match(/^\d+[.)]\s+(.+)/)?.[1];
    if (item) items.push(item.trim());
    else if (items.length > 0) break;
  }
  return items.slice(0, 12);
}

function unavailable(reference: WorkItemReference, failureReason: string): ReferencedWorkItem {
  return {
    source: reference.source,
    repository: reference.repository,
    issueNumber: reference.issueNumber,
    contentStatus: "unavailable",
    truncated: false,
    failureReason
  };
}

function safeFailure(value: string): string {
  return value.replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").slice(0, 240);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
