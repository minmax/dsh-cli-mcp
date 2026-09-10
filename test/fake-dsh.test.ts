// Tests for the FakeDsh class itself — and demonstration of how tests can
// use it to validate lib behavior with fine-grained expectations.
//
// Each test creates a FakeDsh instance, exercises it directly (no spawning),
// and asserts on:
//   - parsed args behavior
//   - state mutations
//   - call records (what was received)
//   - error responses (validation, failures)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalMode, FakeDsh } from "./fake-dsh.js";

describe("FakeDsh — argument parsing & validation", () => {
  it("handles one-shot prompt", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--print", "--prompt", "hello"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok: hello\n");
  });

  it("rejects an empty prompt", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--print", "--prompt", ""], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("empty prompt");
  });

  it("validates approval mode (rejects bogus)", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--print", "--prompt", "x", "--approval-mode", "bogus"], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("bad approval mode: bogus");
  });

  it("accepts all 4 canonical approval modes", async () => {
    for (const mode of ["yolo", "default", "auto", "plan"] as ApprovalMode[]) {
      const fake = new FakeDsh();
      const r = await fake.handle(["--print", "--prompt", "x", "--approval-mode", mode], {}, "/tmp");
      expect(r.exitCode).toBe(0);
    }
  });

  it("respects allowedApprovalModes restriction", async () => {
    const fake = new FakeDsh({ allowedApprovalModes: ["yolo"] });
    const r = await fake.handle(["--print", "--prompt", "x", "--approval-mode", "plan"], {}, "/tmp");
    expect(r.exitCode).toBe(2);
  });

  it("rejects bad session id", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--session", "../etc/passwd", "--prompt", "x"], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("bad session id");
  });

  it("enforces expectedSessionIds whitelist", async () => {
    const fake = new FakeDsh({ expectedSessionIds: ["known-1", "known-2"] });
    const r = await fake.handle(["--session", "rogue", "--prompt", "x"], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unexpected session id");
  });
});

describe("FakeDsh — sessions", () => {
  it("creates a new session on first --session --prompt", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--session", "abc", "--prompt", "first"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    const sess = fake.getSession("abc");
    expect(sess).toBeDefined();
    expect(sess?.messageCount).toBe(2);
    expect(sess?.summary).toBe("first");
  });

  it("appends to existing session on subsequent calls", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--session", "abc", "--prompt", "first"], {}, "/tmp");
    await fake.handle(["--session", "abc", "--prompt", "second"], {}, "/tmp");
    const sess = fake.getSession("abc");
    expect(sess?.messageCount).toBe(4);
    expect(sess?.summary).toBe("second");
  });

  it("reuses a pre-seeded session", async () => {
    const fake = new FakeDsh();
    fake.seedSession({
      id: "pre",
      createdAt: "2020-01-01T00:00:00Z",
      cwd: "/tmp",
      summary: "old",
      messageCount: 10,
      messages: [],
    });
    const r = await fake.handle(["--session", "pre", "--prompt", "new"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    expect(fake.getSession("pre")?.messageCount).toBe(12);
  });

  it("--kill-session removes the session", async () => {
    const fake = new FakeDsh();
    fake.seedSession({
      id: "k",
      createdAt: "2020-01-01T00:00:00Z",
      cwd: "/tmp",
      summary: "kill me",
      messageCount: 1,
      messages: [],
    });
    const r = await fake.handle(["--kill-session", "k"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    expect(fake.getSession("k")).toBeUndefined();
  });

  it("--kill-session returns 1 for missing session", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--kill-session", "nope"], {}, "/tmp");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });

  it("--list-sessions returns all sessions", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--session", "a", "--prompt", "x"], {}, "/tmp");
    await fake.handle(["--session", "b", "--prompt", "y"], {}, "/tmp");
    const r = await fake.handle(["--list-sessions"], {}, "/tmp");
    expect(r.stdout).toContain("a\t");
    expect(r.stdout).toContain("b\t");
  });
});

describe("FakeDsh — models", () => {
  it("--list-models returns 3 default models", async () => {
    const fake = new FakeDsh();
    const r = await fake.handle(["--list-models"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("deepseek-chat");
  });

  it("respects custom model list", async () => {
    const fake = new FakeDsh({
      models: [
        {
          id: "custom-1",
          displayName: "C1",
          provider: "x",
          contextWindow: 1,
          supportsTools: false,
          supportsVision: false,
        },
      ],
    });
    const r = await fake.handle(["--list-models"], {}, "/tmp");
    expect(r.stdout).toContain("custom-1");
    expect(r.stdout).not.toContain("deepseek-chat");
  });
});

describe("FakeDsh — call records & expectations", () => {
  it("records every call with args, env, cwd, at", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--print", "--prompt", "x"], { DSH_TEST: "1" }, "/work");
    expect(fake.calls).toHaveLength(1);
    const c = fake.calls[0]!;
    expect(c.args).toEqual(["--print", "--prompt", "x"]);
    expect(c.cwd).toBe("/work");
    expect(c.env["DSH_TEST"]).toBe("1");
    expect(typeof c.at).toBe("number");
  });

  it("wasCalledWith finds a matching call", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--print", "--prompt", "a"], {}, "/");
    await fake.handle(["--print", "--prompt", "b"], {}, "/");
    expect(fake.wasCalledWith("--print", "--prompt", "a")).toBe(true);
    expect(fake.wasCalledWith("--print", "--prompt", "b")).toBe(true);
    expect(fake.wasCalledWith("--list-models")).toBe(false);
  });

  it("callsMatching filters with a predicate", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--print", "--prompt", "a"], {}, "/");
    await fake.handle(["--list-models"], {}, "/");
    const printCalls = fake.callsMatching((c) => c.args.includes("--print"));
    expect(printCalls).toHaveLength(1);
  });

  it("lastCall returns the most recent", async () => {
    const fake = new FakeDsh();
    await fake.handle(["--print", "--prompt", "a"], {}, "/");
    await fake.handle(["--print", "--prompt", "b"], {}, "/");
    expect(fake.lastCall()?.args).toEqual(["--print", "--prompt", "b"]);
  });
});

describe("FakeDsh — failure simulation", () => {
  it("setFailNext returns failure once then clears", async () => {
    const fake = new FakeDsh();
    fake.setFailNext(42, "boom\n");
    const r1 = await fake.handle(["--print", "--prompt", "x"], {}, "/");
    expect(r1.exitCode).toBe(42);
    expect(r1.stderr).toBe("boom\n");
    const r2 = await fake.handle(["--print", "--prompt", "x"], {}, "/");
    expect(r2.exitCode).toBe(0);
  });

  it("sleep makes calls take time", async () => {
    const fake = new FakeDsh({ sleepMs: 50 });
    const start = Date.now();
    await fake.handle(["--print", "--prompt", "x"], {}, "/");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("setSleep updates the delay at runtime", async () => {
    const fake = new FakeDsh();
    fake.setSleep(50);
    const start = Date.now();
    await fake.handle(["--print", "--prompt", "x"], {}, "/");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe("FakeDsh — persistence across calls (in-process)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "fake-dsh-state-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists sessions via stateDir", async () => {
    const f1 = new FakeDsh({ stateDir });
    await f1.handle(["--session", "persist", "--prompt", "hello"], {}, "/");
    expect(f1.getSession("persist")).toBeDefined();

    // New instance reads the state file
    const f2 = new FakeDsh({ stateDir });
    expect(f2.getSession("persist")).toBeDefined();
    expect(f2.getSession("persist")?.summary).toBe("hello");
  });
});

describe("FakeDsh — export to file", () => {
  it("--export writes JSON to target path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fake-dsh-export-"));
    try {
      const fake = new FakeDsh({ stateDir });
      fake.seedSession({
        id: "exp",
        createdAt: "2020-01-01T00:00:00Z",
        cwd: "/tmp",
        summary: "exported",
        messageCount: 1,
        messages: [{ role: "user", content: "hi", at: "2020-01-01T00:00:00Z" }],
      });
      const target = join(stateDir, "out.json");
      const r = await fake.handle(["--session", "exp", "--export", target], {}, "/");
      expect(r.exitCode).toBe(0);
      const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(target)).toBe(true);
      const data = JSON.parse(readFileSync(target, "utf8"));
      expect(data.id).toBe("exp");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
