// The single tool this server exposes in v0.1.0: `dsh`. It accepts a
// `prompt`, an optional absolute `cwd`, and an optional `timeout_ms`, and
// hands the prompt to the locally installed `dsh` binary via `runDsh`.
//
// Future versions will add session, ACP/stream transport, mid-run control,
// and model-list — see the README.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runDsh } from "../cli.ts";
import { describeDshError, InvalidArgumentError } from "../lib/errors.ts";
import type { ToolDefinition } from "../types.ts";

const DSH_TOOL: ToolDefinition = {
  name: "dsh",
  description:
    "Run a prompt through your locally installed DeepSeek Harness CLI (`dsh --print`). " +
    "Blocks until dsh settles, then returns the captured stdout, the last 4 KB of stderr, " +
    "the exit code, and the wall-clock time. dsh cannot see this conversation, so the " +
    "prompt must be self-contained: file paths, goal, constraints, expected output format.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The complete task for the DeepSeek Harness agent. Must be self-contained — dsh " +
          "cannot see your conversation, so include everything it needs (file paths, goal, " +
          "constraints, expected output format).",
      },
      cwd: {
        type: "string",
        description:
          "Absolute path where dsh will run. Defaults to the server's cwd. Relative paths " + "are rejected.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        description:
          "Wall-clock timeout in milliseconds. Defaults to " +
          DEFAULT_TIMEOUT_MS +
          " (5 min). Hard ceiling is " +
          MAX_TIMEOUT_MS +
          " (30 min). On timeout, dsh is sent SIGTERM (then SIGKILL after 5 s) and the " +
          "tool result is reported as a `DshTimeout` error.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const TOOLS: readonly ToolDefinition[] = [DSH_TOOL] as const;

/** Dispatch the `dsh` tool call. */
export async function callDsh(args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = parseDshArgs(args);
  try {
    const result = await runDsh({
      prompt: parsed.prompt,
      options: buildOptions(parsed),
    });
    return toolResult(renderSuccess(parsed.prompt, result));
  } catch (err) {
    return toolResult(describeDshError(err), true);
  }
}

interface ParsedDshArgs {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}

function buildOptions(parsed: ParsedDshArgs): { cwd?: string; timeoutMs?: number } {
  const opts: { cwd?: string; timeoutMs?: number } = {};
  if (parsed.cwd !== undefined) opts.cwd = parsed.cwd;
  if (parsed.timeoutMs !== undefined) opts.timeoutMs = parsed.timeoutMs;
  return opts;
}

function parseDshArgs(raw: Record<string, unknown>): ParsedDshArgs {
  const prompt = raw.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InvalidArgumentError("`prompt` is required and must be a non-empty string");
  }

  const cwd = raw.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new InvalidArgumentError("`cwd` must be a non-empty string when provided");
    }
    if (!cwd.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(cwd)) {
      throw new InvalidArgumentError("`cwd` must be an absolute path");
    }
  }

  const timeoutMs = raw.timeout_ms;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new InvalidArgumentError("`timeout_ms` must be an integer >= 1000");
    }
    if (timeoutMs > MAX_TIMEOUT_MS) {
      throw new InvalidArgumentError(`\`timeout_ms\` must be <= ${MAX_TIMEOUT_MS}`);
    }
  }

  const out: ParsedDshArgs = { prompt };
  if (cwd !== undefined) out.cwd = cwd;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

function renderSuccess(prompt: string, result: import("../types.ts").DshRunResult): string {
  const lines: string[] = [];
  lines.push("dsh completed.");
  lines.push("");
  lines.push(`- command: ${result.command} ${quoteArgs(result.args)}`);
  lines.push(`- exit_code: ${result.code}`);
  lines.push(`- wall_ms: ${result.wallMs}`);
  lines.push(`- prompt_bytes: ${Buffer.byteLength(prompt, "utf8")}`);
  lines.push(`- stdout_bytes: ${Buffer.byteLength(result.stdout, "utf8")}`);
  lines.push(`- stderr_bytes: ${Buffer.byteLength(result.stderr, "utf8")}`);
  lines.push("");
  lines.push("--- stdout ---");
  lines.push(result.stdout.length === 0 ? "(empty)" : result.stdout);
  lines.push("--- stderr (tail) ---");
  lines.push(result.stderr.length === 0 ? "(empty)" : result.stderr);
  return lines.join("\n");
}

function quoteArgs(args: string[]): string {
  return args
    .map((a) => {
      if (a.length === 0) return '""';
      if (/^[\w@./:+=-]+$/.test(a)) return a;
      return JSON.stringify(a);
    })
    .join(" ");
}

function toolResult(text: string, isError: boolean = false): CallToolResult {
  const content = [{ type: "text" as const, text }];
  return isError ? { content, isError: true } : { content };
}
