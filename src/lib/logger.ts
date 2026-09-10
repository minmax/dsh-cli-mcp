// Minimal stderr logger.
//
// We write only to `process.stderr` and only on the warn / error path — every
// byte on `stdout` is part of the MCP JSON-RPC stream and would corrupt the
// wire protocol. The success path is silent.

/** A single log record. */
export interface LogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

function write(level: LogEntry["level"], msg: string, meta?: Record<string, unknown>): void {
  const tail = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  process.stderr.write(`dsh-cli-mcp: [${level}] ${msg}${tail}\n`);
}

/**
 * Log a warning. The success path of the server should never call this — it
 * exists to surface configuration problems, dropped messages, and spawn
 * failures that the caller might otherwise miss.
 */
export function warn(msg: string, meta?: Record<string, unknown>): void {
  write("warn", msg, meta);
}

/** Log a fatal / unexpected error. Use sparingly. */
export function error(msg: string, meta?: Record<string, unknown>): void {
  write("error", msg, meta);
}

/** Informational log; not used on the success path. */
export function info(msg: string, meta?: Record<string, unknown>): void {
  write("info", msg, meta);
}
