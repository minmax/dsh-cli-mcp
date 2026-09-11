// dsh_reply — resume session by ID with a new prompt.
//
// Tier 1: session-resume
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const REPLY_TOOL: ToolDefinition = {
  name: "dsh_reply",
  description:
    "Continue an existing dsh session. Pass the session id and a new prompt; the model " +
    "sees the prior transcript and answers the new prompt. Returns the assistant's response.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "ID of an existing dsh session (8-char hex).",
      },
      prompt: {
        type: "string",
        description: "The new prompt to send to the model in this session.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "Wall-clock timeout in ms (default 5 min).",
      },
    },
    required: ["session_id", "prompt"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export function buildReplyTool(): ToolDefinition {
  return REPLY_TOOL;
}

export async function callDshReply(lib: Lib, args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = parseReplyArgs(args);
  try {
    const response = await lib.resumeSession(parsed.sessionId, parsed.prompt);
    return {
      content: [
        {
          type: "text",
          text: `session: ${parsed.sessionId}\n\n${response}`,
        },
      ],
    };
  } catch (err) {
    return errorResult(err);
  }
}

interface ParsedReplyArgs {
  sessionId: string;
  prompt: string;
}

function parseReplyArgs(raw: Record<string, unknown>): ParsedReplyArgs {
  const sessionId = raw.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new InvalidArgumentError("`session_id` is required and must be a non-empty string");
  }
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
    throw new InvalidArgumentError("`session_id` must be alphanumeric or hyphen");
  }

  const prompt = raw.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new InvalidArgumentError("`prompt` is required and must be a non-empty string");
  }

  return { sessionId, prompt };
}

function errorResult(err: unknown): CallToolResult {
  const e = err as Error & { code?: string; context?: Record<string, unknown> };
  return {
    content: [
      {
        type: "text",
        text: `[${e.code ?? "error"}] ${e.message}${e.context ? `\n${JSON.stringify(e.context)}` : ""}`,
      },
    ],
    isError: true,
  };
}
