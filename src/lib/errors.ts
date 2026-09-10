// Typed errors raised by the dsh-cli-mcp adapter. Tool handlers catch every
// thrown error in the dispatcher and convert it into a `toolResult(text,
// isError: true)` payload — see `server.ts` — so callers never see a raw
// `Error` object. Keeping the type hierarchy small makes that conversion
// boring.

/** Base class. The discriminator is `name`, not a class identity check. */
export class DshMcpError extends Error {
  override readonly name: string;

  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Caller passed an invalid argument — equivalent to a schema validation fail. */
export class InvalidArgumentError extends DshMcpError {
  constructor(message: string) {
    super("InvalidArgument", message);
  }
}

/** The `dsh` binary could not be found or could not be spawned. */
export class BinaryNotFoundError extends DshMcpError {
  constructor(message: string) {
    super("BinaryNotFound", message);
  }
}

/** The `dsh` process exited with a non-zero code. */
export class DshExitError extends DshMcpError {
  readonly code: number;

  constructor(code: number, message: string) {
    super("DshExit", message);
    this.code = code;
  }
}

/** The `dsh` process did not finish before the configured timeout. */
export class DshTimeoutError extends DshMcpError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message: string) {
    super("DshTimeout", message);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Format a `DshMcpError` chain (up to 5 frames) for the `toolResult` payload.
 * Only the message string is sent to the host — the stack trace stays in
 * `process.stderr` for the operator.
 */
export function describeDshError(err: unknown): string {
  const lines: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 5) {
    if (current instanceof Error) {
      lines.push(`${depth === 0 ? "error" : "caused by"}: ${current.name}: ${current.message}`);
      current = current.cause;
      depth += 1;
      continue;
    }
    lines.push(
      `${depth === 0 ? "error" : "caused by"}: ${typeof current === "string" ? current : JSON.stringify(current)}`,
    );
    break;
  }
  return lines.join("\n");
}
