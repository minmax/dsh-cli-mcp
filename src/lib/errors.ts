/**
 * lib errors — типизированные ошибки, которые MCP-server возвращает хосту.
 * Каждая ошибка мапится в isError=true text content + код.
 */

export class LibError extends Error {
  public readonly code: string;
  public readonly kind: "internal" | "protocol" | "tool" | "user";
  public readonly context: Record<string, unknown> | undefined;

  constructor(code: string, message: string, kind: LibError["kind"] = "tool", context?: Record<string, unknown>) {
    super(message);
    this.name = "LibError";
    this.code = code;
    this.kind = kind;
    this.context = context;
  }
}

export class SessionNotFoundError extends LibError {
  constructor(sessionId: string) {
    super("session_not_found", `Session ${sessionId} not found`, "tool", { sessionId });
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends LibError {
  constructor(sessionId: string) {
    super("session_already_exists", `Session ${sessionId} already exists`, "tool", { sessionId });
    this.name = "SessionAlreadyExistsError";
  }
}

export class ProcessSpawnError extends LibError {
  constructor(binary: string, cause: unknown) {
    super("process_spawn_failed", `Failed to spawn ${binary}: ${(cause as Error).message}`, "internal", {
      binary,
      cause: String(cause),
    });
    this.name = "ProcessSpawnError";
  }
}

export class TimeoutError extends LibError {
  constructor(ms: number, op: string) {
    super("timeout", `Operation ${op} timed out after ${ms}ms`, "tool", { ms, op });
    this.name = "TimeoutError";
  }
}

export class CliError extends LibError {
  public readonly exitCode: number | null;
  public readonly stderr: string;
  constructor(exitCode: number | null, stderr: string, op: string) {
    super("cli_error", `CLI ${op} failed (exit ${exitCode}): ${stderr.split("\n")[0]?.slice(0, 200) ?? ""}`, "tool", {
      exitCode,
      stderr: stderr.slice(0, 2000),
      op,
    });
    this.name = "CliError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class UnsupportedFeatureError extends LibError {
  constructor(feature: string) {
    super("unsupported_feature", `Feature ${feature} is not supported by this CLI`, "user", { feature });
    this.name = "UnsupportedFeatureError";
  }
}

export class InvalidArgumentError extends LibError {
  constructor(argOrMessage: string, reason?: string) {
    if (reason === undefined) {
      super("invalid_argument", argOrMessage, "user");
    } else {
      super("invalid_argument", `Invalid ${argOrMessage}: ${reason}`, "user", { arg: argOrMessage, reason });
    }
    this.name = "InvalidArgumentError";
  }
}

/**
 * Convert a caught error into a human-readable text for MCP tool result.
 */
export function describeDshError(err: unknown): string {
  if (err instanceof LibError) {
    return `[${err.code}] ${err.message}`;
  }
  const e = err as Error;
  return `[internal_error] ${e?.message ?? String(err)}`;
}

// ============================================================================
// Legacy aliases (for the v0.1.0 cli.ts wrapper that hasn't been refactored yet)
// ============================================================================

/** @deprecated use CliError */
export class DshExitError extends LibError {
  constructor(exitCode: number, message: string) {
    super("cli_error", message, "tool", { exitCode });
    this.name = "DshExitError";
  }
}

/** @deprecated use TimeoutError */
export class DshTimeoutError extends LibError {
  constructor(ms: number, message: string) {
    super("timeout", message, "tool", { ms });
    this.name = "DshTimeoutError";
  }
}
