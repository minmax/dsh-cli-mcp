/**
 * lib config — чтение настроек из env + defaults.
 */
import type { ApprovalMode, LibConfig } from "./lib-spec.js";

const DEFAULTS = {
  cliBinary: "dsh",
  defaultArgs: ["--print"] as const,
  defaultTransport: "acp" as const,
  transportEnvVar: "DSH_MCP_TRANSPORT",
  // Override env var for the CLI binary itself. We accept both the canonical
  // DSH_BINARY and the legacy DSH_MCP_BIN for backward compat with the v0.1.0
  // scaffold.
  binaryEnvVar: "DSH_BINARY",
  stateDir: process.env.DSH_MCP_STATE_DIR ?? `${process.env.HOME}/.dsh-cli-mcp/state`,
  maxConcurrent: Number(process.env.DSH_MCP_MAX_CONCURRENT ?? 4),
  defaultApprovalMode: (process.env.DSH_MCP_APPROVAL ?? "default") as ApprovalMode,
  callTimeoutMs: Number(process.env.DSH_MCP_CALL_TIMEOUT_MS ?? 5 * 60_000),
  serverTimeoutMs: Number(process.env.DSH_MCP_SERVER_TIMEOUT_MS ?? 30 * 60_000),
  maxOutputBytes: Number(process.env.DSH_MCP_MAX_OUTPUT_BYTES ?? 50 * 1024 * 1024),
  allowedModels: new Set<string>((process.env.DSH_MCP_ALLOWED_MODELS ?? "").split(",").filter(Boolean)),
};

export function loadConfig(): LibConfig {
  return { ...DEFAULTS };
}

/** Где lib хранит state-файлы (sesssions, history). */
export const STATE_DIR = DEFAULTS.stateDir;
