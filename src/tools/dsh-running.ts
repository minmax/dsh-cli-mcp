// dsh_running — list active runs.
//
// Helper tool (not in lib v1 explicitly, but useful for observability).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const RUNNING_TOOL: ToolDefinition = {
  name: "dsh_running",
  description:
    "List currently active dsh runs (with their sessionId). Useful for the host to " +
    "check what's in flight before issuing abort/kill/steer.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function buildRunningTool(): ToolDefinition {
  return RUNNING_TOOL;
}

export async function callDshRunning(lib: Lib): Promise<CallToolResult> {
  // Access activeRuns via reflection — same as the existing pattern in lib.ts
  const active = (lib as unknown as { activeRuns?: Map<string, AbortController> }).activeRuns;
  if (!active) {
    return { content: [{ type: "text", text: "No active runs (lib internals unavailable)." }] };
  }
  if (active.size === 0) {
    return { content: [{ type: "text", text: "No active runs." }] };
  }
  const ids = Array.from(active.keys());
  const lines = [`${ids.length} active run(s):`];
  for (const id of ids) lines.push(`- ${id}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
