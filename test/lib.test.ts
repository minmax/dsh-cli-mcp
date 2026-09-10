// Unit tests for lib v1 internals (no server spawn).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlotSemaphore } from "../src/lib/semaphore.js";
import { SessionStore } from "../src/lib/session-store.js";

describe("SlotSemaphore", () => {
  it("acquires and releases", async () => {
    const sem = new SlotSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.freeSlots).toBe(0);
    r1();
    expect(sem.freeSlots).toBe(1);
    r2();
    expect(sem.freeSlots).toBe(2);
  });

  it("queues when max is reached", async () => {
    const sem = new SlotSemaphore(1);
    const r1 = await sem.acquire();
    let acquired = false;
    const p = sem.acquire().then((r) => {
      acquired = true;
      r();
    });
    await new Promise((r) => setImmediate(r));
    expect(acquired).toBe(false);
    expect(sem.waitingCount).toBe(1);
    r1();
    await p;
    expect(acquired).toBe(true);
  });

  it("rejects with TimeoutError when no slot available", async () => {
    const sem = new SlotSemaphore(1);
    const r1 = await sem.acquire();
    await expect(sem.acquire(50)).rejects.toThrow("timed out");
    r1();
  });

  it("rejects invalid max", () => {
    expect(() => new SlotSemaphore(0)).toThrow();
    expect(() => new SlotSemaphore(-1)).toThrow();
  });
});

describe("SessionStore", () => {
  let stateDir: string;
  let store: SessionStore;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "session-store-test-"));
    store = new SessionStore(stateDir, 10);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates and lists sessions", async () => {
    const s1 = await store.create({ cwd: "/tmp", initialPrompt: "hello" });
    const s2 = await store.create({ cwd: "/var", initialPrompt: "world" });
    expect(s1.id).toMatch(/^[a-f0-9]{8}$/);
    expect(s2.id).toMatch(/^[a-f0-9]{8}$/);
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(s2.id); // sorted by lastUsedAt desc
  });

  it("touches session and updates lastUsedAt + messageCount", async () => {
    const s = await store.create({ cwd: "/tmp", initialPrompt: "first" });
    await new Promise((r) => setTimeout(r, 10));
    await store.touch(s.id, "second", "response");
    const updated = await store.get(s.id);
    expect(updated.messageCount).toBe(2);
    expect(updated.summary).toBe("second");
  });

  it("kills a session and removes state file", async () => {
    const s = await store.create({ cwd: "/tmp", initialPrompt: "kill me" });
    expect(existsSync(join(stateDir, `${s.id}.json`))).toBe(true);
    await store.kill(s.id);
    expect(existsSync(join(stateDir, `${s.id}.json`))).toBe(false);
    await expect(store.get(s.id)).rejects.toThrow("not found");
  });

  it("exports a session to a JSON file", async () => {
    const s = await store.create({ cwd: "/tmp", initialPrompt: "export me" });
    const target = join(stateDir, "export.json");
    await store.exportTo(s.id, target);
    expect(existsSync(target)).toBe(true);
    const content = JSON.parse(readFileSync(target, "utf8"));
    expect(content.info.id).toBe(s.id);
  });

  it("prunes LRU when max exceeded", async () => {
    const small = new SessionStore(stateDir, 2);
    const s1 = await small.create({ cwd: "/tmp", initialPrompt: "1" });
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await small.create({ cwd: "/tmp", initialPrompt: "2" });
    await new Promise((r) => setTimeout(r, 10));
    const s3 = await small.create({ cwd: "/tmp", initialPrompt: "3" });
    const list = await small.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual([s2.id, s3.id].sort());
    expect(existsSync(join(stateDir, `${s1.id}.json`))).toBe(false);
  });

  it("rejects bad session id", async () => {
    await expect(store.get("../etc/passwd")).rejects.toThrow("Bad session id");
  });
});
