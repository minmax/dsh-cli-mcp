/**
 * FakeDsh — TypeScript mock of the real `dsh` CLI.
 *
 * Lives at test/fake-dsh.ts. The actual binary that gets spawned by lib is
 * test/fake-dsh-cli.ts (a 10-line shim that calls into this class).
 *
 * The shell-script fake we used before was a dumb echo. This class is a real
 * mock with:
 *   - argument parsing (matches real `dsh` CLI conventions)
 *   - stateful sessions (Map<id, Session>)
 *   - validation of approval-mode, session-id, model-id
 *   - configurable failure modes (slow, error, killed)
 *   - expectations that the test can attach and assert on
 *
 * Each test creates its own FakeDsh instance. The lib is expected to spawn the
 * binary and pass args; the fake parses, validates, and returns proper outputs.
 *
 * Tests can either:
 *   (a) assert on the returned {stdout, stderr, exitCode} synchronously, or
 *   (b) call fake.expect(...).wasCalled() to validate args the lib sent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalMode = "yolo" | "default" | "auto" | "plan";

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface FakeSession {
  id: string;
  createdAt: string;
  cwd: string;
  modelId?: string;
  summary: string;
  messageCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string; at: string }>;
}

export interface CallRecord {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  at: number;
}

export interface FakeOptions {
  /** Initial set of models; default: deepseek-chat, deepseek-coder, deepseek-vision */
  models?: ModelInfo[];
  /** When set, every handle() call sleeps this many ms before returning */
  sleepMs?: number;
  /** When set, the next handle() call returns this error (then clears) */
  failNext?: { exitCode: number; stderr: string };
  /** When true, all calls log to stderr for debugging */
  verbose?: boolean;
  /** Allowed approval modes (default: all 4); others are rejected as invalid */
  allowedApprovalModes?: ApprovalMode[];
  /** When set, validate that --session was one of these ids (rejects others) */
  expectedSessionIds?: string[];
  /** Persistent state file (if running across multiple spawns) */
  stateDir?: string;
}

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "deepseek-chat",
    displayName: "DeepSeek Chat",
    provider: "deepseek",
    contextWindow: 32768,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "deepseek-coder",
    displayName: "DeepSeek Coder",
    provider: "deepseek",
    contextWindow: 16384,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "deepseek-vision",
    displayName: "DeepSeek Vision",
    provider: "deepseek",
    contextWindow: 16384,
    supportsTools: false,
    supportsVision: true,
  },
];

const ALLOWED_APPROVAL_MODES: ApprovalMode[] = ["yolo", "default", "auto", "plan"];

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export class FakeDsh {
  private readonly models: ModelInfo[];
  private sleepMs: number;
  private failNext?: { exitCode: number; stderr: string };
  private readonly verbose: boolean;
  private readonly allowedApprovalModes: ApprovalMode[];
  private readonly expectedSessionIds?: string[];
  private readonly stateDir?: string;

  /** All calls made to this fake (in order). Tests assert on this. */
  readonly calls: CallRecord[] = [];

  /** Sessions in this fake. Tests can pre-populate. */
  private readonly sessions = new Map<string, FakeSession>();

  constructor(opts: FakeOptions = {}) {
    this.models = opts.models ?? DEFAULT_MODELS;
    this.sleepMs = opts.sleepMs ?? 0;
    if (opts.failNext !== undefined) this.failNext = opts.failNext;
    this.verbose = opts.verbose ?? false;
    this.allowedApprovalModes = opts.allowedApprovalModes ?? ALLOWED_APPROVAL_MODES;
    if (opts.expectedSessionIds !== undefined) this.expectedSessionIds = opts.expectedSessionIds;
    if (opts.stateDir !== undefined) this.stateDir = opts.stateDir;

    if (this.stateDir) {
      this.loadState();
    }
  }

  // ==========================================================================
  // Test-side API: pre-populate, expect, retrieve
  // ==========================================================================

  /** Pre-seed a session so the test can assert "lib resumes this session". */
  seedSession(session: FakeSession): void {
    this.sessions.set(session.id, session);
    if (this.verbose) this.log(`seeded session ${session.id}`);
  }

  /** Get a session (for assertions). */
  getSession(id: string): FakeSession | undefined {
    return this.sessions.get(id);
  }

  /** All sessions, sorted by createdAt desc. */
  listSessions(): FakeSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** All call records (for assertions). */
  allCalls(): readonly CallRecord[] {
    return this.calls;
  }

  /** Find calls that match a predicate. */
  callsMatching(pred: (c: CallRecord) => boolean): CallRecord[] {
    return this.calls.filter(pred);
  }

  /** Returns true if a call was made matching the predicate. */
  wasCalledWith(...expectedArgs: string[]): boolean {
    return this.calls.some((c) => {
      if (c.args.length < expectedArgs.length) return false;
      return expectedArgs.every((a, i) => c.args[i] === a);
    });
  }

  /** Last call (or undefined). */
  lastCall(): CallRecord | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Inject a transient failure for the next call. */
  setFailNext(exitCode: number, stderr: string): void {
    this.failNext = { exitCode, stderr };
  }

  /** Make all subsequent calls slow (simulate a slow CLI). */
  setSleep(ms: number): void {
    this.sleepMs = ms;
  }

  // ==========================================================================
  // Subprocess side: handle one invocation. Returns {stdout, stderr, exitCode}.
  // ==========================================================================

  async handle(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    cwd: string,
  ): Promise<HandleResult> {
    const callRec: CallRecord = { args: [...args], env, cwd, at: Date.now() };
    this.calls.push(callRec);
    if (this.verbose) this.log(`call: ${args.join(" ")} (cwd=${cwd})`);

    // Parse args first (so we can validate even if dispatch doesn't match)
    const parsed = parseArgs(args);

    // Validate prompt emptiness regardless of dispatch
    if (parsed.prompt !== undefined && parsed.prompt.length === 0) {
      return { stdout: "", stderr: "empty prompt\n", exitCode: 2 };
    }

    // Failure simulation (one-shot)
    if (this.failNext) {
      const f = this.failNext;
      delete this.failNext;
      return { stdout: "", stderr: f.stderr, exitCode: f.exitCode };
    }

    // Sleep simulation
    if (this.sleepMs > 0) {
      await new Promise((r) => setTimeout(r, this.sleepMs));
    }

    // Dispatch
    if (parsed.listModels) return this.handleListModels();
    if (parsed.killSession) return this.handleKillSession(parsed.killSession);
    if (parsed.listSessions) return this.handleListSessions();
    if (parsed.exportTo) return this.handleExport(parsed.sessionId!, parsed.exportTo);
    if (parsed.sessionId && parsed.prompt)
      return this.handleResume(parsed.sessionId, parsed.prompt, parsed.approvalMode, cwd);
    if (parsed.prompt) return this.handleOneShot(parsed.prompt, parsed.approvalMode, cwd);
    return { stdout: "noop\n", stderr: "", exitCode: 0 };
  }

  // ==========================================================================
  // Handlers — one per subcommand
  // ==========================================================================

  private handleListModels(): HandleResult {
    const lines = this.models.map(
      (m) => `${m.id}\t${m.displayName}\t${m.provider}\t${m.contextWindow}\t${m.supportsTools}\t${m.supportsVision}`,
    );
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  private handleListSessions(): HandleResult {
    const lines = this.listSessions().map((s) => `${s.id}\t${s.createdAt}\t${s.cwd}\t${s.messageCount}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  private handleKillSession(id: string): HandleResult {
    if (!SESSION_ID_RE.test(id)) {
      return { stdout: "", stderr: `bad session id: ${id}\n`, exitCode: 2 };
    }
    if (!this.sessions.has(id)) {
      return { stdout: "", stderr: `session not found: ${id}\n`, exitCode: 1 };
    }
    this.sessions.delete(id);
    if (this.stateDir) this.persistState();
    return { stdout: `killed ${id}\n`, stderr: "", exitCode: 0 };
  }

  private handleExport(id: string, targetPath: string): HandleResult {
    const sess = this.sessions.get(id);
    if (!sess) {
      return { stdout: "", stderr: `session not found: ${id}\n`, exitCode: 1 };
    }
    writeFileSync(targetPath, JSON.stringify(sess, null, 2));
    return { stdout: `exported ${id} to ${targetPath}\n`, stderr: "", exitCode: 0 };
  }

  private handleResume(id: string, prompt: string, approvalMode: string | undefined, cwd: string): HandleResult {
    // Validate
    if (!SESSION_ID_RE.test(id)) {
      return { stdout: "", stderr: `bad session id: ${id}\n`, exitCode: 2 };
    }
    if (this.expectedSessionIds && !this.expectedSessionIds.includes(id)) {
      return { stdout: "", stderr: `unexpected session id: ${id}\n`, exitCode: 2 };
    }
    if (approvalMode && !this.allowedApprovalModes.includes(approvalMode as ApprovalMode)) {
      return { stdout: "", stderr: `bad approval mode: ${approvalMode}\n`, exitCode: 2 };
    }
    if (prompt.length === 0) {
      return { stdout: "", stderr: `empty prompt\n`, exitCode: 2 };
    }

    let sess = this.sessions.get(id);
    if (!sess) {
      sess = {
        id,
        createdAt: new Date().toISOString(),
        cwd,
        summary: prompt.slice(0, 120),
        messageCount: 0,
        messages: [],
      };
      this.sessions.set(id, sess);
    }
    const now = new Date().toISOString();
    sess.messages.push({ role: "user", content: prompt, at: now });
    sess.messageCount += 1;

    // Fake model response: a deterministic, short, parseable string
    const response = `[${id}/${sess.messageCount}] ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}\n`;
    sess.messages.push({ role: "assistant", content: response, at: now });
    sess.messageCount += 1;
    sess.summary = prompt.slice(0, 120);

    if (this.stateDir) this.persistState();
    return { stdout: response, stderr: "", exitCode: 0 };
  }

  private handleOneShot(prompt: string, approvalMode: string | undefined, _cwd: string): HandleResult {
    if (approvalMode && !this.allowedApprovalModes.includes(approvalMode as ApprovalMode)) {
      return { stdout: "", stderr: `bad approval mode: ${approvalMode}\n`, exitCode: 2 };
    }
    if (prompt.length === 0) {
      return { stdout: "", stderr: `empty prompt\n`, exitCode: 2 };
    }
    return { stdout: `ok: ${prompt}\n`, stderr: "", exitCode: 0 };
  }

  // ==========================================================================
  // Persistence (optional, for live state across spawns)
  // ==========================================================================

  private stateFile(): string {
    if (!this.stateDir) throw new Error("stateDir not set");
    return join(this.stateDir, "_state.json");
  }

  private loadState(): void {
    const p = this.stateFile();
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8")) as { sessions: FakeSession[] };
      for (const s of data.sessions) this.sessions.set(s.id, s);
      if (this.verbose) this.log(`loaded ${data.sessions.length} sessions from state`);
    } catch {
      // Corrupt state; ignore
    }
  }

  private persistState(): void {
    if (!this.stateDir) return;
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.stateFile(), JSON.stringify({ sessions: Array.from(this.sessions.values()) }, null, 2));
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private log(msg: string): void {
    process.stderr.write(`[fake-dsh] ${msg}\n`);
  }
}

// ----------------------------------------------------------------------------
// Argument parser
// ----------------------------------------------------------------------------

interface ParsedArgs {
  prompt?: string;
  sessionId?: string;
  listModels: boolean;
  listSessions: boolean;
  killSession?: string;
  exportTo?: string;
  approvalMode?: string;
  print: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    listModels: false,
    listSessions: false,
    print: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--print":
        out.print = true;
        break;
      case "--list-models":
        out.listModels = true;
        break;
      case "--list-sessions":
        out.listSessions = true;
        break;
      case "--session": {
        const v = argv[++i];
        if (v !== undefined) out.sessionId = v;
        break;
      }
      case "--prompt": {
        const v = argv[++i];
        if (v !== undefined) out.prompt = v;
        break;
      }
      case "--kill-session": {
        const v = argv[++i];
        if (v !== undefined) out.killSession = v;
        break;
      }
      case "--export": {
        const v = argv[++i];
        if (v !== undefined) out.exportTo = v;
        break;
      }
      case "--approval-mode": {
        const v = argv[++i];
        if (v !== undefined) out.approvalMode = v;
        break;
      }
      case "--sleep": {
        // consumed by the binary wrapper, not by handle() — skip
        i += 1;
        break;
      }
      default:
        // unknown flag — ignore (real dsh might error; we accept)
        break;
    }
  }
  return out;
}

export interface HandleResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
