#!/usr/bin/env node

// MCP server entry point. Speaks stdio JSON-RPC 2.0 using the official
// `@modelcontextprotocol/sdk` transport, and registers 7 tools:
//   - dsh          (Tier 1: prompt, cwd, timeout)
//   - dsh_reply    (Tier 1: session-resume)
//   - dsh_models   (Tier 1: discovery-model-list)
//   - dsh_sessions (Tier 1+3: list + export)
//   - dsh_running  (helper: active runs)
//   - dsh_send     (Tier 3: abort/steer/kill)
//   - dsh_history  (Tier 2: transcript)
//
// Wire protocol versions: 2025-06-18 (preferred), 2025-03-26, 2024-11-05.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LibError } from "./lib/errors.js";
import { Lib } from "./lib/lib.js";
import { error as logError, warn as logWarn } from "./lib/logger.js";
import { callDsh, TOOLS as DSH_TOOLS } from "./tools/dsh.js";
import { buildHistoryTool, callDshHistory } from "./tools/dsh-history.js";
import { buildModelsTool, callDshModels } from "./tools/dsh-models.js";
import { buildReplyTool, callDshReply } from "./tools/dsh-reply.js";
import { buildRunningTool, callDshRunning } from "./tools/dsh-running.js";
import { buildSendTool, callDshSend } from "./tools/dsh-send.js";
import { buildSessionsTool, callDshSessions } from "./tools/dsh-sessions.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const FALLBACK_PROTOCOL = "2025-06-18";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = readFileSync(join(here, "..", "package.json"), "utf8");
    const version = (JSON.parse(manifest) as { version?: unknown }).version;
    if (typeof version === "string") return version;
  } catch {
    // Unreadable manifest is not worth failing the handshake over.
  }
  return "0.0.0";
}

const serverName = "dsh-cli-mcp";
const serverVersion = readVersion();
const lib = new Lib(serverName, serverVersion);

const ALL_TOOLS = [
  ...DSH_TOOLS,
  buildReplyTool(),
  buildModelsTool(),
  buildSessionsTool(),
  buildRunningTool(),
  buildSendTool(),
  buildHistoryTool(),
];

const server = new Server(
  {
    name: serverName,
    version: serverVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.onerror = (err) => {
  logError("server error", { message: (err as Error).message });
};

server.registerCapabilities({
  tools: { listChanged: false },
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: ALL_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "dsh":
        return callDsh(record);
      case "dsh_reply":
        return await callDshReply(lib, record);
      case "dsh_models":
        return await callDshModels(lib);
      case "dsh_sessions":
        return await callDshSessions(lib, record);
      case "dsh_running":
        return await callDshRunning(lib);
      case "dsh_send":
        return await callDshSend(lib, record);
      case "dsh_history":
        return await callDshHistory(lib, record);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    if (err instanceof LibError) {
      return {
        content: [{ type: "text", text: `[${err.code}] ${err.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `[internal_error] ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  try {
    await lib.start();
    await server.connect(transport);
  } catch (err) {
    logError("failed to start server", { message: (err as Error).message });
    process.exit(1);
  }
}

function shutdown(reason: string, code: number = 0): void {
  logWarn(`shutting down: ${reason}`);
  void lib.stop().finally(() => {
    process.exit(code);
  });
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") shutdown("stdout closed", 0);
});
process.stdin.on("end", () => shutdown("stdin closed", 0));

void main().catch((err: unknown) => {
  logError("unhandled error in main", { message: (err as Error).message });
  process.exit(1);
});

export { ALL_TOOLS, FALLBACK_PROTOCOL, PROTOCOL_VERSIONS };
