// dsh_send — send a command to a running session (abort, steer).
//
// Tier 3: mid-run-abort + mid-run-steer
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const SEND_TOOL: ToolDefinition = {
  name: "dsh_send",
  description:
    "Send a command to a running dsh session. Commands: " +
    "'abort' (kill current run, keep session), " +
    "'steer' (abort + new prompt), " +
    "'kill' (destroy session entirely).",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "ID of the running session.",
      },
      command: {
        type: "string",
        enum: ["abort", "steer", "kill"],
        description: "What to do with the running session.",
      },
      prompt: {
        type: "string",
        description: "New prompt (required for command=steer).",
      },
    },
    required: ["session_id", "command"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export function buildSendTool(): ToolDefinition {
  return SEND_TOOL;
}

export async function callDshSend(lib: Lib, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const sessionId = args.session_id;
    const command = args.command;

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new InvalidArgumentError("`session_id` is required");
    }
    if (command !== "abort" && command !== "steer" && command !== "kill") {
      throw new InvalidArgumentError("`command`", `must be abort, steer, or kill, got '${String(command)}'`);
    }

    if (command === "abort") {
      await lib.abortRun(sessionId);
      return { content: [{ type: "text", text: `Session ${sessionId}: run aborted.` }] };
    }
    if (command === "steer") {
      const prompt = args.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) {
        throw new InvalidArgumentError("`prompt` is required for command=steer");
      }
      await lib.steerRun(sessionId, prompt);
      return { content: [{ type: "text", text: `Session ${sessionId}: steered with new prompt.` }] };
    }
    // command === "kill"
    await lib.killSession(sessionId);
    return { content: [{ type: "text", text: `Session ${sessionId}: killed.` }] };
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
