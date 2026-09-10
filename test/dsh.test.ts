// Smoke test for the dsh-cli-mcp adapter.
//
// The default unit suite uses a fake `dsh` binary (a tiny shell script that
// echoes its arguments and exits 0) and drives the real server over stdio.
// To exercise the real `dsh` binary end-to-end use:
//   DSH_CLI_MCP_LIVE=1 pnpm run test:live

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const live = process.env.DSH_CLI_MCP_LIVE === "1";

interface JsonRpcResponse {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

class Client {
  private readonly child;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(env: Record<string, string> = {}) {
    const serverPath = resolve(process.cwd(), "dist/server.js");
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.ingest(chunk));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number") {
        const resolver = this.pending.get(msg.id);
        if (resolver) {
          this.pending.delete(msg.id);
          resolver(msg);
        }
      }
    }
  }

  send(msg: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  call(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const promise = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async handshake(): Promise<JsonRpcResponse> {
    const init = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
    this.child.kill();
  }
}

interface FakeBin {
  dir: string;
  bin: string;
  cleanup: () => void;
}

function makeFakeBin(scriptBody: string): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-test-"));
  const bin = join(dir, "dsh");
  const script = `#!/bin/sh\n${scriptBody}\n`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const FAKE_DSH_BODY = `cat <<'EOF'
hello from fake dsh
prompt: $1
EOF`;

let fake: FakeBin | undefined;

beforeAll(() => {
  if (!live) {
    fake = makeFakeBin(FAKE_DSH_BODY);
  }
});
afterAll(() => {
  fake?.cleanup();
});

/**
 * A tool call can be reported two ways:
 *   1. as a `toolResult` with `isError: true` and a text payload; or
 *   2. as a JSON-RPC `-32603` error wrapping the underlying exception.
 * Both are valid MCP wire-level error responses. Tests should accept either.
 */
function readFailureText(res: JsonRpcResponse): string {
  if (res.error) return res.error.message;
  const content = res.result?.content as Array<{ text?: string }> | undefined;
  return content?.[0]?.text ?? "";
}

describe.skipIf(!existsSync(resolve(process.cwd(), "dist/server.js")))("dsh-cli-mcp", () => {
  it("completes the initialize + tools/list + tools/call round trip", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      const init = await client.handshake();
      expect(init.result?.protocolVersion).toBe("2025-06-18");
      expect(init.result?.serverInfo).toMatchObject({ name: "dsh" });

      const list = await client.call("tools/list");
      const tools = list.result?.tools as Array<{ name: string; description: string }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("dsh");
      expect(tools[0]?.description).toContain("DeepSeek Harness");

      const call = await client.call("tools/call", {
        name: "dsh",
        arguments: { prompt: "echo ok" },
      });
      expect(call.error).toBeUndefined();
      expect(call.result?.isError).toBeFalsy();
      const content = (call.result?.content ?? []) as Array<{ text: string }>;
      const text = content[0]?.text ?? "";
      expect(text).toContain("dsh completed");
      expect(text).toContain("exit_code: 0");
      expect(text).toContain("hello from fake dsh");
    } finally {
      client.close();
    }
  }, 15_000);

  it("rejects a missing prompt with an error response", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      await client.handshake();
      const res = await client.call("tools/call", { name: "dsh", arguments: {} });
      // Either a toolResult with isError=true or a JSON-RPC error is acceptable.
      const failed = res.error !== undefined || res.result?.isError === true;
      expect(failed).toBe(true);
      const text = readFailureText(res);
      expect(text).toContain("prompt");
    } finally {
      client.close();
    }
  }, 10_000);

  it("rejects a relative cwd with an error response", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      await client.handshake();
      const res = await client.call("tools/call", {
        name: "dsh",
        arguments: { prompt: "go", cwd: "relative" },
      });
      const failed = res.error !== undefined || res.result?.isError === true;
      expect(failed).toBe(true);
      const text = readFailureText(res);
      expect(text).toContain("absolute");
    } finally {
      client.close();
    }
  }, 10_000);
});

describe.runIf(live)("live dsh", () => {
  it("answers a prompt end to end", async () => {
    const client = new Client();
    try {
      await client.handshake();
      const res = await client.call("tools/call", {
        name: "dsh",
        arguments: { prompt: "Reply with exactly: DSH_MCP_OK. Do not edit any files." },
        timeout_ms: 60_000,
      });
      expect(res.error).toBeUndefined();
      expect(res.result?.isError).toBeFalsy();
    } finally {
      client.close();
    }
  }, 120_000);
});
