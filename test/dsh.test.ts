// Test suite for dsh-cli-mcp v1.
//
// The default unit suite uses a fake `dsh` binary (a tiny shell script) and
// drives the real server over stdio. To exercise the real `dsh` binary
// end-to-end use:
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
  stateDir: string;
  cleanup: () => void;
}

/**
 * Smart fake dsh: handles --list-models, --list-sessions, --session, --kill-session,
 * and the basic --print. Stores session state in $FAKE_STATE_DIR.
 */
const FAKE_DSH_BODY = `
STATE_DIR="$FAKE_STATE_DIR"
mkdir -p "$STATE_DIR"

# Parse args
LIST_MODELS=0
LIST_SESSIONS=0
SESSION_ID=""
KILL_SESSION=""
ABORT=0
EXPORT=""
PRINT_PROMPT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --print) shift;;
    --list-models) LIST_MODELS=1; shift;;
    --list-sessions) LIST_SESSIONS=1; shift;;
    --session) shift; SESSION_ID="$1"; shift;;
    --prompt) shift; PRINT_PROMPT="$1"; shift;;
    --kill-session) shift; KILL_SESSION="$1"; shift;;
    --abort) ABORT=1; shift;;
    --export) shift; EXPORT="$1"; shift;;
    *) shift;;
  esac
done

if [ "$LIST_MODELS" = "1" ]; then
  cat <<'EOF'
deepseek-chat	DeepSeek Chat	deepseek	32768
deepseek-coder	DeepSeek Coder	deepseek	16384
deepseek-vision	DeepSeek Vision	deepseek	16384
EOF
  exit 0
fi

if [ "$LIST_SESSIONS" = "1" ]; then
  if [ -d "$STATE_DIR" ]; then
    for f in "$STATE_DIR"/*.json; do
      [ -f "$f" ] || continue
      cat "$f" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1
    done
  fi
  exit 0
fi

if [ -n "$KILL_SESSION" ]; then
  rm -f "$STATE_DIR/$KILL_SESSION.json"
  echo "killed $KILL_SESSION"
  exit 0
fi

if [ -n "$EXPORT" ]; then
  if [ -f "$STATE_DIR/$SESSION_ID.json" ]; then
    cp "$STATE_DIR/$SESSION_ID.json" "$EXPORT"
  fi
  exit 0
fi

if [ -n "$SESSION_ID" ] && [ -n "$PRINT_PROMPT" ]; then
  # Resume session
  if [ -f "$STATE_DIR/$SESSION_ID.json" ]; then
    # Append to existing
    echo "Session $SESSION_ID resumed. Response: ok."
    exit 0
  else
    # Create new
    cat > "$STATE_DIR/$SESSION_ID.json" <<JSON
{
  "version": 1,
  "info": {
    "id": "$SESSION_ID",
    "createdAt": "2026-01-01T00:00:00Z",
    "lastUsedAt": "2026-01-01T00:00:00Z",
    "cwd": "/tmp",
    "summary": "$(echo "$PRINT_PROMPT" | head -c 120 | tr -d '\\n')",
    "messageCount": 2
  },
  "transcript": []
}
JSON
    echo "Session $SESSION_ID created. Response: $PRINT_PROMPT (echoed)"
    exit 0
  fi
fi

if [ -n "$PRINT_PROMPT" ]; then
  echo "dsh completed: $PRINT_PROMPT"
  exit 0
fi

echo "no-op"
exit 0
`;

function makeFakeBin(): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-test-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-mcp-state-"));
  const bin = join(dir, "dsh");
  const script = `#!/bin/sh\nFAKE_STATE_DIR="${stateDir}"\n${FAKE_DSH_BODY}\n`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    stateDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

let fake: FakeBin | undefined;

beforeAll(() => {
  if (!live) {
    fake = makeFakeBin();
  }
});
afterAll(() => {
  fake?.cleanup();
});

function readFailureText(res: JsonRpcResponse): string {
  if (res.error) return res.error.message;
  const content = res.result?.content as Array<{ text?: string }> | undefined;
  return content?.[0]?.text ?? "";
}

describe.skipIf(!existsSync(resolve(process.cwd(), "dist/server.js")))("dsh-cli-mcp v1", () => {
  it("completes the initialize + tools/list round trip with 7 tools", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      const init = await client.handshake();
      expect(init.result?.protocolVersion).toBe("2025-06-18");
      expect(init.result?.serverInfo).toMatchObject({ name: "dsh-cli-mcp" });

      const list = await client.call("tools/list");
      const tools = list.result?.tools as Array<{ name: string; description: string }>;
      expect(tools).toHaveLength(7);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "dsh",
        "dsh_history",
        "dsh_models",
        "dsh_reply",
        "dsh_running",
        "dsh_send",
        "dsh_sessions",
      ]);
    } finally {
      client.close();
    }
  }, 15_000);

  it("dsh tool runs a prompt and returns the result", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      const call = await client.call("tools/call", {
        name: "dsh",
        arguments: { prompt: "echo ok" },
      });
      expect(call.error).toBeUndefined();
      expect(call.result?.isError).toBeFalsy();
      const content = (call.result?.content ?? []) as Array<{ text: string }>;
      const text = content[0]?.text ?? "";
      expect(text).toContain("dsh completed");
    } finally {
      client.close();
    }
  }, 10_000);

  it("dsh_models returns a list of models", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      const call = await client.call("tools/call", { name: "dsh_models", arguments: {} });
      expect(call.error).toBeUndefined();
      const text = ((call.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("deepseek-chat");
      expect(text).toContain("deepseek-coder");
      expect(text).toContain("3 model(s)");
    } finally {
      client.close();
    }
  }, 10_000);

  it("dsh_sessions returns the list of sessions", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      // First create a session via dsh_reply
      const reply = await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { session_id: "abc12345", prompt: "hello" },
      });
      expect(reply.error).toBeUndefined();
      // Then list
      const call = await client.call("tools/call", { name: "dsh_sessions", arguments: { action: "list" } });
      expect(call.error).toBeUndefined();
      const text = ((call.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("abc12345");
    } finally {
      client.close();
    }
  }, 15_000);

  it("dsh_reply runs a session and returns a response", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      const call = await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { session_id: "test1234", prompt: "hello again" },
      });
      expect(call.error).toBeUndefined();
      const text = ((call.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("test1234");
      expect(text).toMatch(/resumed|created/);
    } finally {
      client.close();
    }
  }, 10_000);

  it("dsh_reply persists state across two calls", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      // First call
      const first = await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { session_id: "resume01", prompt: "first" },
      });
      expect(first.error).toBeUndefined();
      // Second call — must be a "resumed" since lib now has local state
      const second = await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { session_id: "resume01", prompt: "second" },
      });
      expect(second.error).toBeUndefined();
      const text = ((second.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("resumed");
      // Also check that dsh_sessions now knows about it
      const list = await client.call("tools/call", { name: "dsh_sessions", arguments: { action: "list" } });
      const listText = ((list.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(listText).toContain("resume01");
    } finally {
      client.close();
    }
  }, 20_000);

  it("dsh_send with command=kill removes the session", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      // Create
      await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { session_id: "killme", prompt: "create me" },
      });
      // Kill
      const call = await client.call("tools/call", {
        name: "dsh_send",
        arguments: { session_id: "killme", command: "kill" },
      });
      expect(call.error).toBeUndefined();
      const text = ((call.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("killed");
    } finally {
      client.close();
    }
  }, 15_000);

  it("rejects a missing prompt with an error response", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      const res = await client.call("tools/call", { name: "dsh", arguments: {} });
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
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
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

  it("rejects dsh_reply without session_id", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const client = new Client({ DSH_MCP_BIN: fake.bin, DSH_MCP_STATE_DIR: fake.stateDir });
    try {
      await client.handshake();
      const res = await client.call("tools/call", {
        name: "dsh_reply",
        arguments: { prompt: "no session" },
      });
      const failed = res.error !== undefined || res.result?.isError === true;
      expect(failed).toBe(true);
      const text = readFailureText(res);
      expect(text).toContain("session_id");
    } finally {
      client.close();
    }
  }, 10_000);
});
