// dsh_sessions — list persistent sessions.
//
// Tier 1: session-list + Tier 3: session-export
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const SESSIONS_TOOL: ToolDefinition = {
  name: "dsh_sessions",
  description:
    "List persistent dsh sessions, sorted by lastUsedAt desc. Each session has id, " +
    "cwd, model, message count, summary, created/lastUsed timestamps.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "export"],
        description: "What to do. Default 'list'. 'export' requires session_id and target_path.",
      },
      session_id: {
        type: "string",
        description: "Session id (required for action=export).",
      },
      target_path: {
        type: "string",
        description: "Absolute path for export file (required for action=export).",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function buildSessionsTool(): ToolDefinition {
  return SESSIONS_TOOL;
}

export async function callDshSessions(lib: Lib, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const action = (args.action as string) ?? "list";
    if (action === "list") {
      const sessions = await lib.listSessions();
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No sessions." }] };
      }
      const lines: string[] = [];
      lines.push(`${sessions.length} session(s):`);
      lines.push("");
      for (const s of sessions) {
        lines.push(`- ${s.id}`);
        lines.push(`    cwd: ${s.cwd}`);
        if (s.modelId) lines.push(`    model: ${s.modelId}`);
        lines.push(`    messages: ${s.messageCount}`);
        lines.push(`    created: ${s.createdAt}`);
        lines.push(`    lastUsed: ${s.lastUsedAt}`);
        lines.push(`    summary: ${s.summary}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    if (action === "export") {
      const sessionId = args.session_id;
      const targetPath = args.target_path;
      if (typeof sessionId !== "string") {
        throw new InvalidArgumentError("`session_id` is required for action=export");
      }
      if (typeof targetPath !== "string" || !targetPath.startsWith("/")) {
        throw new InvalidArgumentError("`target_path` is required and must be absolute");
      }
      await lib.exportSession(sessionId, targetPath);
      return { content: [{ type: "text", text: `Session ${sessionId} exported to ${targetPath}` }] };
    }
    throw new InvalidArgumentError("action", `must be 'list' or 'export', got '${action}'`);
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
