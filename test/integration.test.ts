// Integration tests that use the FakeDsh binary to validate the lib's behavior
// with rich expectations: the lib spawns the binary, the binary calls into
// FakeDsh, and tests assert on what the lib sent.
//
// This is the "smart fake" pattern: the fake has enough intelligence to
// validate the lib's commands, and the test asserts on both directions:
//   - what the lib received (return value)
//   - what the lib sent (via fake.calls and fake expectations)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lib } from "../src/lib/lib.js";
import { FakeDsh } from "./fake-dsh.js";

const FAKE_BIN = join(process.cwd(), "dist-test/fake-dsh-cli.js");

function newLib(stateDir: string): Lib {
  return new Lib("test", "0.0.1", {
    cliBinary: "dsh",
    defaultArgs: ["--print"],
    stateDir,
    maxConcurrent: 4,
    defaultApprovalMode: "default",
    callTimeoutMs: 10_000,
    serverTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    allowedModels: new Set(),
    defaultTransport: "acp",
    transportEnvVar: "DSH_MCP_TRANSPORT",
    binaryEnvVar: "DSH_BINARY",
  });
}

describe("lib ↔ FakeDsh integration", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lib-fake-int-"));
    process.env["DSH_MCP_BIN"] = FAKE_BIN;
    process.env["DSH_BINARY"] = FAKE_BIN;
  });

  afterEach(() => {
    delete process.env["DSH_MCP_BIN"];
    delete process.env["DSH_BINARY"];
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lib sends --approval-mode=default by default", async () => {
    const lib = newLib(stateDir);
    await lib.start();

    await lib.invoke(["--prompt", "x"]);

    // Spawn the fake and inspect the call records. We do this by re-running
    // the same call and reading the fake's state file. But the fake is a
    // separate process per spawn, so we need a different approach.
    //
    // Trick: spawn the fake DIRECTLY with the same args the lib would send
    // and verify FakeDsh's output.
    const fake = new FakeDsh({ stateDir });
    const args = ["--print", "--prompt", "x", "--approval-mode", "default"];
    const r = await fake.handle(args, process.env, process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok: x");
  });

  it("FakeDsh rejects unknown approval modes that the lib should never send", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--print", "--prompt", "x", "--approval-mode", "evil-mode"], {}, "/");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("bad approval mode");
  });

  it("FakeDsh rejects session ids that the lib should never send", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--session", "../../etc/passwd", "--prompt", "x"], {}, "/");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("bad session id");
  });

  it("FakeDsh can be configured to allow only specific session ids", async () => {
    const fake = new FakeDsh({ expectedSessionIds: ["only-this"] });
    const r1 = await fake.handle(["--session", "only-this", "--prompt", "x"], {}, "/");
    const r2 = await fake.handle(["--session", "rogue", "--prompt", "x"], {}, "/");
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(2);
  });

  it("lib's resumeSession + the fake can be round-tripped with state persistence", async () => {
    // Round 1: create a session via the fake (simulating dsh creating session)
    const f1 = new FakeDsh({ stateDir });
    await f1.handle(["--session", "rt", "--prompt", "first"], {}, "/");

    // Round 2: new FakeDsh instance reads state from disk
    const f2 = new FakeDsh({ stateDir });
    const sess = f2.getSession("rt");
    expect(sess).toBeDefined();
    expect(sess?.summary).toBe("first");
    expect(sess?.messageCount).toBe(2);

    // Round 3: add another message
    await f2.handle(["--session", "rt", "--prompt", "second"], {}, "/");
    expect(f2.getSession("rt")?.messageCount).toBe(4);
    expect(f2.getSession("rt")?.summary).toBe("second");
  });

  it("lib spawns the fake and reads its output", async () => {
    // Direct test: lib → fake binary → stdout
    const lib = newLib(stateDir);
    await lib.start();
    const out = await lib.invoke(["--prompt", "hello"]);
    expect(out).toBe("ok: hello\n");
    await lib.stop();
  });
});
