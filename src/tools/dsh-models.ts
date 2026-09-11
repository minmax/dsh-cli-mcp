// dsh_models — list available models.
//
// Tier 1: discovery-model-list
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Lib } from "../lib/lib.js";
import type { ToolDefinition } from "../types.js";

const MODELS_TOOL: ToolDefinition = {
  name: "dsh_models",
  description:
    "List models that dsh can run. Returns id, display name, provider, context window, " +
    "and capability flags (tools, vision). Filtered by DSH_MCP_ALLOWED_MODELS env var.",
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

export function buildModelsTool(): ToolDefinition {
  return MODELS_TOOL;
}

export async function callDshModels(lib: Lib): Promise<CallToolResult> {
  try {
    const models = await lib.listModels();
    if (models.length === 0) {
      return {
        content: [{ type: "text", text: "No models available (CLI returned empty list)." }],
      };
    }
    const lines: string[] = [];
    lines.push(`${models.length} model(s):`);
    lines.push("");
    for (const m of models) {
      const caps: string[] = [];
      if (m.supportsTools) caps.push("tools");
      if (m.supportsVision) caps.push("vision");
      lines.push(`- ${m.id}`);
      lines.push(`    display: ${m.displayName}`);
      lines.push(`    provider: ${m.provider}`);
      lines.push(`    context: ${m.contextWindow}`);
      if (caps.length) lines.push(`    capabilities: ${caps.join(", ")}`);
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
