import { execFile } from "node:child_process";
import { access, constants, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeanRigorConfig } from "../config/schema.js";
import type { WorkspacePreparation } from "./types.js";

const execFileAsync = promisify(execFile);

export async function preparePhaseWorkspace(args: {
  workspacePath: string;
  repositoryRoot: string;
  validationCommands: string[];
  config: LeanRigorConfig;
}): Promise<WorkspacePreparation> {
  const checkedAt = new Date().toISOString();
  const packageJson = path.join(args.workspacePath, "package.json");
  if (!await exists(packageJson)) {
    return preparation({
      status: "available",
      packageManager: "none",
      dependencies: "not_applicable",
      bootstrapRequired: false,
      reason: "No package.json was detected in the phase workspace.",
      checkedAt,
      evidence: ["package.json absent"]
    });
  }

  const packageJsonData = await readPackageJson(args.workspacePath);
  const manager = await detectPackageManager(args.workspacePath, packageJsonData);
  if (!hasDeclaredDependencies(packageJsonData)) {
    return preparation({
      status: "available",
      packageManager: manager.packageManager,
      dependencies: "not_applicable",
      bootstrapRequired: false,
      reason: "package.json declares no installable dependencies.",
      checkedAt,
      evidence: manager.evidence
    });
  }
  const dependenciesAvailable = await dependenciesUsable(args.workspacePath, args.validationCommands);
  if (dependenciesAvailable) {
    return preparation({
      status: "available",
      packageManager: manager.packageManager,
      dependencies: "available",
      bootstrapRequired: false,
      reason: "Existing workspace dependencies are available.",
      checkedAt,
      evidence: manager.evidence
    });
  }

  const command = manager.bootstrapCommand ?? fallbackBootstrapCommand();
  const result = preparation({
    status: args.config.execution.dependencyBootstrap === "auto-lockfile" && manager.lockfilePreserving ? "prepared" : "blocked",
    packageManager: manager.packageManager,
    dependencies: "missing",
    bootstrapRequired: true,
    bootstrapCommand: command,
    approvalRequired: args.config.execution.dependencyBootstrap !== "auto-lockfile" || !manager.lockfilePreserving,
    reason: manager.lockfilePreserving
      ? "Dependencies are missing in the isolated phase worktree; a lockfile-preserving bootstrap is required before provider dispatch."
      : "Dependencies are missing in the isolated phase worktree and no lockfile-preserving bootstrap was detected.",
    checkedAt,
    evidence: [...manager.evidence, "node_modules/.bin or declared validation tooling unavailable"]
  });

  if (result.status !== "prepared") return result;
  const before = await manifestIdentity(args.workspacePath);
  try {
    const install = await execFileAsync(command[0]!, command.slice(1), { cwd: args.workspacePath, encoding: "utf8", maxBuffer: 1024 * 1024 * 8 }) as { stdout: string; stderr: string };
    const after = await manifestIdentity(args.workspacePath);
    if (before !== after) {
      return { ...result, status: "failed", approvalRequired: true, reason: "Bootstrap changed package manifests or lockfiles; provider dispatch is blocked.", evidence: [...result.evidence, "manifest identity changed", `${install.stdout}${install.stderr}`.slice(0, 1000)] };
    }
    return { ...result, status: "prepared", dependencies: "available", reason: "Lockfile-preserving dependency bootstrap completed.", evidence: [...result.evidence, "bootstrap exit status 0"] };
  } catch (error) {
    return { ...result, status: "failed", approvalRequired: true, reason: `Dependency bootstrap failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

interface DetectedPackageManager {
  packageManager: WorkspacePreparation["packageManager"];
  bootstrapCommand?: string[];
  lockfilePreserving: boolean;
  evidence: string[];
}

async function detectPackageManager(workspacePath: string, packageJson = {} as Record<string, unknown>): Promise<DetectedPackageManager> {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (await exists(path.join(workspacePath, "pnpm-lock.yaml")) || declared.startsWith("pnpm@")) return { packageManager: "pnpm", bootstrapCommand: ["pnpm", "install", "--frozen-lockfile"], lockfilePreserving: true, evidence: evidence("pnpm-lock.yaml", declared) };
  if (await exists(path.join(workspacePath, "yarn.lock")) || declared.startsWith("yarn@")) return { packageManager: "yarn", bootstrapCommand: ["yarn", "install", "--immutable"], lockfilePreserving: true, evidence: evidence("yarn.lock", declared) };
  if (await exists(path.join(workspacePath, "bun.lockb")) || await exists(path.join(workspacePath, "bun.lock")) || declared.startsWith("bun@")) return { packageManager: "bun", bootstrapCommand: ["bun", "install", "--frozen-lockfile"], lockfilePreserving: true, evidence: evidence("bun lockfile", declared) };
  if (await exists(path.join(workspacePath, "package-lock.json")) || await exists(path.join(workspacePath, "npm-shrinkwrap.json")) || declared.startsWith("npm@")) return { packageManager: "npm", bootstrapCommand: ["npm", "ci"], lockfilePreserving: true, evidence: evidence("package-lock.json", declared) };
  return { packageManager: "npm", bootstrapCommand: ["npm", "install"], lockfilePreserving: false, evidence: evidence("package.json without lockfile", declared) };
}

function hasDeclaredDependencies(packageJson: Record<string, unknown>): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((key) => {
    const value = packageJson[key];
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
  });
}

async function dependenciesUsable(workspacePath: string, validationCommands: string[]): Promise<boolean> {
  if (!await exists(path.join(workspacePath, "node_modules"))) return false;
  const toolNames = validationCommands.flatMap((command) => command.match(/\b(vitest|jest|tsc|eslint|tsx|vite|webpack|rollup)\b/g) ?? []);
  for (const tool of new Set(toolNames)) {
    if (!await executableExists(path.join(workspacePath, "node_modules", ".bin", tool))) return false;
  }
  return true;
}

type PreparationArgs = Omit<WorkspacePreparation, "commandRisk" | "approvalRequired" | "bootstrapCommand"> & {
  approvalRequired?: boolean;
  bootstrapCommand?: string[];
};

function preparation(args: PreparationArgs): WorkspacePreparation {
  return {
    ...args,
    bootstrapCommand: args.bootstrapCommand?.join(" "),
    approvalRequired: args.approvalRequired ?? false,
    commandRisk: {
      localWrite: Boolean(args.bootstrapCommand),
      network: Boolean(args.bootstrapCommand),
      lifecycleScripts: Boolean(args.bootstrapCommand),
      lockfilePreserving: args.bootstrapCommand ? !args.bootstrapCommand.includes("install") || args.bootstrapCommand.includes("ci") || args.bootstrapCommand.includes("--frozen-lockfile") || args.bootstrapCommand.includes("--immutable") : true,
      manifestMutationExpected: args.bootstrapCommand?.join(" ") === "npm install"
    }
  };
}

function fallbackBootstrapCommand(): string[] {
  return ["npm", "install"];
}

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function manifestIdentity(workspacePath: string): Promise<string> {
  const names = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
  const parts = await Promise.all(names.map(async (name) => {
    const file = path.join(workspacePath, name);
    try {
      const stats = await lstat(file);
      return `${name}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return `${name}:absent`;
    }
  }));
  return parts.join("|");
}

async function exists(file: string): Promise<boolean> {
  return access(file, constants.F_OK).then(() => true).catch(() => false);
}

async function executableExists(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(() => true).catch(() => false);
}

function evidence(lockfile: string, declared: string): string[] {
  return [lockfile, declared ? `packageManager=${declared}` : "packageManager not declared"];
}
