import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ValidationEvidence } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 16 * 1024;
const CLAUDE_LAUNCHER_ENVIRONMENT = [
  "CLAUDE_PLUGIN_ROOT",
  "LEANRIGOR_CLAUDE_PLUGIN_ROOT",
  "LEANRIGOR_RUNTIME_SOURCE"
] as const;

export interface ValidationRunRequest {
  phaseId: string;
  workspacePath: string;
  commands: readonly string[];
  timeoutSeconds: number;
}

export interface ValidationCommandRunner {
  run(request: ValidationRunRequest): Promise<ValidationEvidence[]>;
}

/**
 * Executes only commands already approved in a phase brief. Unlike provider
 * evidence, these results are owned by LeanRigor's coordinator and are used by
 * the completion gate as the authoritative validation record.
 */
export class WorkspaceValidationRunner implements ValidationCommandRunner {
  async run(request: ValidationRunRequest): Promise<ValidationEvidence[]> {
    const evidence: ValidationEvidence[] = [];
    for (const command of request.commands) {
      evidence.push(await runCommand(request.phaseId, request.workspacePath, command, request.timeoutSeconds));
    }
    return evidence;
  }
}

async function runCommand(phaseId: string, workspacePath: string, command: string, timeoutSeconds: number): Promise<ValidationEvidence> {
  const timestamp = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(shell(), shellArgs(command), {
      cwd: workspacePath,
      // A phase validation command verifies the repository, not the ambient
      // Claude marketplace launcher. Do not leak launcher-only variables into
      // child tests: LeanRigor's own installation-mode tests deliberately
      // branch on them.
      env: validationEnvironment(),
      encoding: "utf8",
      timeout: Math.max(1, timeoutSeconds) * 1000,
      maxBuffer: MAX_OUTPUT_BYTES
    }) as { stdout: string; stderr: string };
    return runnerEvidence(phaseId, command, 0, `${stdout}${stderr}`.trim() || "Command completed successfully.", timestamp);
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
    const timedOut = failed.killed || failed.signal === "SIGTERM" || /timed out/i.test(failed.message ?? "");
    const exitStatus = typeof failed.code === "number" ? failed.code : timedOut ? 124 : 1;
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim()
      || (timedOut ? `Command timed out after ${timeoutSeconds} seconds.` : failed.message ?? "Validation command failed without output.");
    return runnerEvidence(phaseId, command, exitStatus, output, timestamp);
  }
}

function runnerEvidence(phaseId: string, command: string, exitStatus: number, output: string, timestamp: string): ValidationEvidence {
  return {
    phaseId,
    command,
    exitStatus,
    result: boundOutput(output),
    status: exitStatus === 0 ? "passed" : "failed",
    skipped: false,
    source: "runner",
    timestamp
  };
}

function shell(): string {
  return process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "bash";
}

function shellArgs(command: string): string[] {
  return process.platform === "win32" ? ["/d", "/c", command] : ["-lc", command];
}

function validationEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of CLAUDE_LAUNCHER_ENVIRONMENT) delete environment[variable];
  return environment;
}

function boundOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return value;
  return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[output truncated by LeanRigor]`;
}
