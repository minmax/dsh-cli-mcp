// dsh_history — get session transcript.
//
// Tier 2: observability-session-replay (read-only)
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const HISTORY_TOOL: ToolDefinition = {
  name: "dsh_history",
  description:
    "Get the full transcript of a dsh session. Returns user and assistant messages " +
    "with timestamps. Useful for replay, debugging, and migration.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "ID of the session.",
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function buildHistoryTool(): ToolDefinition {
  return HISTORY_TOOL;
}

export async function callDshHistory(lib: Lib, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const sessionId = args.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new InvalidArgumentError("`session_id` is required");
    }
    const state = await lib.sessionStore.getState(sessionId);
    const lines: string[] = [];
    lines.push(`Session ${state.info.id}`);
    lines.push(`  cwd: ${state.info.cwd}`);
    lines.push(`  model: ${state.info.modelId ?? "(default)"}`);
    lines.push(`  created: ${state.info.createdAt}`);
    lines.push(`  messages: ${state.info.messageCount}`);
    lines.push("");
    lines.push("--- transcript ---");
    for (const msg of state.transcript) {
      lines.push(`[${msg.at}] ${msg.role.toUpperCase()}:`);
      lines.push(msg.content);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return errorResult(err);
  }
}

function errorResult(err: unknown): CallToolResult {
  const e = err as Error & { code?: string };
  return {
    content: [{ type: "text", text: `[${e.code ?? "error"}] ${e.message}` }],
    isError: true,
  };
}
