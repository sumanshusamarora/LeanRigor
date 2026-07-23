import type { ExecutionCapabilities, ExecutionHandle, ExecutionStatus, PhaseExecutionInput, PhaseExecutionResult } from "./types.js";

export interface ExecutionProvider {
  readonly id: string;

  capabilities(): Promise<ExecutionCapabilities>;

  dispatch(input: PhaseExecutionInput): Promise<ExecutionHandle>;

  getStatus(handle: ExecutionHandle): Promise<ExecutionStatus>;

  collectResult(handle: ExecutionHandle): Promise<PhaseExecutionResult>;

  cancel(handle: ExecutionHandle, reason?: string): Promise<void>;
}

