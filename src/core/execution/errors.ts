export type ExecutionErrorCode =
  | "provider_unavailable"
  | "provider_unauthenticated"
  | "dispatch_failed"
  | "execution_not_found"
  | "execution_timeout"
  | "execution_cancelled"
  | "result_malformed"
  | "workspace_mismatch"
  | "lease_lost"
  | "revision_conflict"
  | "provider_process_exited"
  | "provider_protocol_error";

export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

