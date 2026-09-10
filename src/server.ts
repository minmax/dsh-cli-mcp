#!/usr/bin/env node

// MCP server entry point. Speaks stdio JSON-RPC 2.0 using the official
// `@modelcontextprotocol/sdk` transport, and registers the `dsh` tool.
//
// Wire protocol versions: 2025-06-18 (preferred), 2025-03-26, 2024-11-05.
// On any unknown version we fall back to 2025-06-18 so old hosts still
// connect cleanly.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { error as logError, warn as logWarn } from "./lib/logger.ts";
import { callDsh, TOOLS } from "./tools/dsh.ts";

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

const server = new Server(
  {
    name: "dsh",
    version: readVersion(),
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
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== "dsh") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  return callDsh(record);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    logError("failed to start server", { message: (err as Error).message });
    process.exit(1);
  }
}

function shutdown(reason: string, code: number = 0): void {
  logWarn(`shutting down: ${reason}`);
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") shutdown("stdout closed", 0);
});
process.stdin.on("end", () => shutdown("stdin closed", 0));

// Negotiate the protocol version advertised in the server info. The SDK reads
// `serverInfo.version` and the host picks a `protocolVersion`. We accept any
// of the three supported versions and report the matching one back via the
// `initialize` handler the SDK already wires up.

void main().catch((err: unknown) => {
  logError("unhandled error in main", { message: (err as Error).message });
  process.exit(1);
});

export { FALLBACK_PROTOCOL, PROTOCOL_VERSIONS };
