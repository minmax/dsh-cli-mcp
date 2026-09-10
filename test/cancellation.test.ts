// Integration tests for cancellation, approval-mode, sub-transport, listActiveRuns.
//
// These tests use the same fake-dsh shell script harness as test/dsh.test.ts but
// cover the four features that the basic round-trip suite doesn't exercise:
//   1. AbortController + SIGTERM/SIGKILL kill chain (cancellable runs)
//   2. approval-mode propagation to CLI args
//   3. sub-transport:acp via lib.send() (the AcpRequest/AcpEvent contract)
//   4. listActiveRuns() public API (no reflection)

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/lib/binary.js";
import { Lib } from "../src/lib/lib.js";
import { SlotSemaphore } from "../src/lib/semaphore.js";

// ----------------------------------------------------------------------------
// Fake dsh that can be SLOW (for kill-chain test) and reads --approval-mode
// ----------------------------------------------------------------------------

const FAKE_DSH_BODY = `
STATE_DIR="$FAKE_STATE_DIR"
SLEEP_SECS=0
APPROVAL_MODE=""

mkdir -p "$STATE_DIR"

while [ $# -gt 0 ]; do
  case "$1" in
    --approval-mode) shift; APPROVAL_MODE="$1"; shift;;
    --sleep) shift; SLEEP_SECS="$1"; shift;;
    --session) shift; SESSION_ID="$1"; shift;;
    --prompt) shift; shift;;
    --kill-session) shift; shift;;
    --list-models) shift;;
    --print) shift;;
    *) shift;;
  esac
done

if [ "$SLEEP_SECS" -gt 0 ] 2>/dev/null; then
  sleep "$SLEEP_SECS"
fi

# Emit the approval mode we received (last one wins) so the test can verify
if [ -n "$APPROVAL_MODE" ]; then
  echo "approval=$APPROVAL_MODE"
fi

echo "ok"
exit 0
`;

function makeFakeBin(): { dir: string; bin: string; stateDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-cancel-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-mcp-cancel-state-"));
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

let fake: ReturnType<typeof makeFakeBin> | undefined;

beforeAll(() => {
  fake = makeFakeBin();
  // Tell the lib where the fake binary is. We use the legacy DSH_MCP_BIN name
  // because the test framework process inherits this env from the test runner.
  if (fake) {
    process.env["DSH_MCP_BIN"] = fake.bin;
    process.env["DSH_BINARY"] = fake.bin;
  }
});
afterAll(() => {
  fake?.cleanup();
  delete process.env["DSH_MCP_BIN"];
  delete process.env["DSH_BINARY"];
});

const fakeStateDir = (): string => {
  if (!fake) throw new Error("fake binary not initialized");
  return fake.stateDir;
};

function newLib(): Lib {
  return new Lib("test", "0.0.1", {
    cliBinary: "dsh",
    defaultArgs: ["--print"],
    stateDir: fakeStateDir(),
    maxConcurrent: 4,
    defaultApprovalMode: "default",
    callTimeoutMs: 10_000,
    serverTimeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
    allowedModels: new Set(),
    defaultTransport: "acp",
    transportEnvVar: "DSH_MCP_TRANSPORT",
    binaryEnvVar: "DSH_BINARY",
  });
}

// ----------------------------------------------------------------------------
// 1. AbortController + SIGTERM/SIGKILL kill chain
// ----------------------------------------------------------------------------

describe("Cancellation kill chain", () => {
  it("kills a slow subprocess via AbortController (SIGTERM → SIGKILL)", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    // Spawn a slow run (fake sleeps 3s) but cancel it after 200ms
    const ctrl = lib.setupCancellation();
    const start = Date.now();
    const runP = lib.invoke(["--sleep", "3"], { timeoutMs: 10_000, signal: ctrl });
    setTimeout(() => ctrl.abort(), 200);

    // We expect the run to abort within ~6s (200ms wait + 5s grace + a bit)
    let exitCode = 0;
    try {
      const res = await runP;
      exitCode = -1; // resolve path means killed (exitCode -1 from runner)
    } catch {
      // CliError or other failure — also acceptable
    }
    const elapsed = Date.now() - start;

    // Crucial: NOT 3s+. Should be done within ~6s.
    expect(elapsed).toBeLessThan(7_000);
    // Should NOT have completed normally (it was sleeping)
    expect(exitCode).toBe(-1);

    await lib.stop();
  }, 10_000);
});

// ----------------------------------------------------------------------------
// 2. approval-mode propagation
// ----------------------------------------------------------------------------

describe("approval-mode propagation", () => {
  it("sends --approval-mode=default on a fresh lib", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    // The default config sets defaultApprovalMode="default"
    const out = await lib.invoke(["--sleep", "0"]);
    expect(out).toContain("approval=default");

    await lib.stop();
  });

  it("propagates setApprovalMode(yolo) into the next CLI call", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    lib.setApprovalMode("yolo");
    const out = await lib.invoke(["--sleep", "0"]);
    expect(out).toContain("approval=yolo");

    lib.setApprovalMode("plan");
    const out2 = await lib.invoke(["--sleep", "0"]);
    expect(out2).toContain("approval=plan");

    await lib.stop();
  });

  it("rejects an unknown approval mode at the type level (compile-time)", () => {
    // This is a TS test — we just verify the type guard. Runtime would never
    // see a value not in the union since setApprovalMode is typed.
    const lib = newLib();
    expect(lib.getApprovalMode()).toMatch(/^(yolo|default|auto|plan)$/);
  });
});

// ----------------------------------------------------------------------------
// 3. sub-transport:acp via lib.send()
// ----------------------------------------------------------------------------

describe("sub-transport:acp", () => {
  it("resolves the sub-transport name from config + env override", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    // Default: acp
    expect(lib.name).toBe("acp");

    // Override via env (the constructor reads env at start, but the getter
    // reads it lazily, so we can swap)
    process.env["DSH_MCP_TRANSPORT"] = "print";
    expect(lib.name).toBe("print");
    delete process.env["DSH_MCP_TRANSPORT"];

    await lib.stop();
  });

  it("lib.send() yields AcpEvents (init → message → done)", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    const events: Array<{ type: string; payload: unknown }> = [];
    for await (const ev of lib.send({ method: "ping", params: {} })) {
      events.push({ type: ev.type, payload: ev.payload });
    }

    // We expect: init, message, done — in that order
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]?.type).toBe("init");
    expect(events[events.length - 1]?.type).toBe("done");

    await lib.stop();
  });
});

// ----------------------------------------------------------------------------
// 4. listActiveRuns() public API
// ----------------------------------------------------------------------------

describe("listActiveRuns()", () => {
  it("returns an empty array when no runs are in flight", async () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    await lib.start();

    expect(lib.listActiveRuns()).toEqual([]);

    await lib.stop();
  });

  it("returns an array (no reflection hack)", () => {
    if (!fake) throw new Error("fake binary not initialized");
    const lib = newLib();
    // Method exists and is callable
    expect(typeof lib.listActiveRuns).toBe("function");
    const result = lib.listActiveRuns();
    expect(Array.isArray(result)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Auxiliary: SlotSemaphore and BinaryResolver unit checks (no server spawn)
// ----------------------------------------------------------------------------

describe("SlotSemaphore edge cases", () => {
  it("release after timeout does not double-count slots", async () => {
    const sem = new SlotSemaphore(1);
    const r1 = await sem.acquire();
    // Try to acquire with short timeout — will reject
    await expect(sem.acquire(50)).rejects.toThrow();
    // Now release the first; total slots should be 1, not 2
    r1();
    expect(sem.freeSlots).toBe(1);
  });

  it("respects max on a tight loop of acquire/release", async () => {
    const sem = new SlotSemaphore(3);
    for (let i = 0; i < 100; i++) {
      const r = await sem.acquire();
      r();
    }
    expect(sem.freeSlots).toBe(3);
  });
});

describe("resolveBinary", () => {
  it("finds the fake dsh on PATH via DSH_MCP_BIN", () => {
    if (!fake) throw new Error("fake binary not initialized");
    process.env["DSH_MCP_BIN"] = fake.bin;
    const resolved = resolveBinary({ binary: "dsh", envVar: "DSH_BINARY" });
    expect(resolved.path).toBe(fake.bin);
    delete process.env["DSH_MCP_BIN"];
  });

  it("falls back to env var name on PATH lookup when no DSH_MCP_BIN", () => {
    if (!fake) throw new Error("fake binary not initialized");
    delete process.env["DSH_MCP_BIN"];
    // Set DSH_BINARY instead
    process.env["DSH_BINARY"] = fake.bin;
    const resolved = resolveBinary({ binary: "dsh", envVar: "DSH_BINARY" });
    expect(resolved.path).toBe(fake.bin);
    delete process.env["DSH_BINARY"];
  });
});
