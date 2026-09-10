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
const DEFAULT_MODELS = [
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
const ALLOWED_APPROVAL_MODES = ["yolo", "default", "auto", "plan"];
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
export class FakeDsh {
    models;
    sleepMs;
    failNext;
    verbose;
    allowedApprovalModes;
    expectedSessionIds;
    stateDir;
    /** All calls made to this fake (in order). Tests assert on this. */
    calls = [];
    /** Sessions in this fake. Tests can pre-populate. */
    sessions = new Map();
    constructor(opts = {}) {
        this.models = opts.models ?? DEFAULT_MODELS;
        this.sleepMs = opts.sleepMs ?? 0;
        if (opts.failNext !== undefined)
            this.failNext = opts.failNext;
        this.verbose = opts.verbose ?? false;
        this.allowedApprovalModes = opts.allowedApprovalModes ?? ALLOWED_APPROVAL_MODES;
        if (opts.expectedSessionIds !== undefined)
            this.expectedSessionIds = opts.expectedSessionIds;
        if (opts.stateDir !== undefined)
            this.stateDir = opts.stateDir;
        if (this.stateDir) {
            this.loadState();
        }
    }
    // ==========================================================================
    // Test-side API: pre-populate, expect, retrieve
    // ==========================================================================
    /** Pre-seed a session so the test can assert "lib resumes this session". */
    seedSession(session) {
        this.sessions.set(session.id, session);
        if (this.verbose)
            this.log(`seeded session ${session.id}`);
    }
    /** Get a session (for assertions). */
    getSession(id) {
        return this.sessions.get(id);
    }
    /** All sessions, sorted by createdAt desc. */
    listSessions() {
        return Array.from(this.sessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    /** All call records (for assertions). */
    allCalls() {
        return this.calls;
    }
    /** Find calls that match a predicate. */
    callsMatching(pred) {
        return this.calls.filter(pred);
    }
    /** Returns true if a call was made matching the predicate. */
    wasCalledWith(...expectedArgs) {
        return this.calls.some((c) => {
            if (c.args.length < expectedArgs.length)
                return false;
            return expectedArgs.every((a, i) => c.args[i] === a);
        });
    }
    /** Last call (or undefined). */
    lastCall() {
        return this.calls[this.calls.length - 1];
    }
    /** Inject a transient failure for the next call. */
    setFailNext(exitCode, stderr) {
        this.failNext = { exitCode, stderr };
    }
    /** Make all subsequent calls slow (simulate a slow CLI). */
    setSleep(ms) {
        this.sleepMs = ms;
    }
    // ==========================================================================
    // Subprocess side: handle one invocation. Returns {stdout, stderr, exitCode}.
    // ==========================================================================
    async handle(args, env, cwd) {
        const callRec = { args: [...args], env, cwd, at: Date.now() };
        this.calls.push(callRec);
        if (this.verbose)
            this.log(`call: ${args.join(" ")} (cwd=${cwd})`);
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
        if (parsed.listModels)
            return this.handleListModels();
        if (parsed.killSession)
            return this.handleKillSession(parsed.killSession);
        if (parsed.listSessions)
            return this.handleListSessions();
        if (parsed.exportTo)
            return this.handleExport(parsed.sessionId, parsed.exportTo);
        if (parsed.sessionId && parsed.prompt)
            return this.handleResume(parsed.sessionId, parsed.prompt, parsed.approvalMode, cwd);
        if (parsed.prompt)
            return this.handleOneShot(parsed.prompt, parsed.approvalMode, cwd);
        return { stdout: "noop\n", stderr: "", exitCode: 0 };
    }
    // ==========================================================================
    // Handlers — one per subcommand
    // ==========================================================================
    handleListModels() {
        const lines = this.models.map((m) => `${m.id}\t${m.displayName}\t${m.provider}\t${m.contextWindow}\t${m.supportsTools}\t${m.supportsVision}`);
        return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    handleListSessions() {
        const lines = this.listSessions().map((s) => `${s.id}\t${s.createdAt}\t${s.cwd}\t${s.messageCount}`);
        return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    handleKillSession(id) {
        if (!SESSION_ID_RE.test(id)) {
            return { stdout: "", stderr: `bad session id: ${id}\n`, exitCode: 2 };
        }
        if (!this.sessions.has(id)) {
            return { stdout: "", stderr: `session not found: ${id}\n`, exitCode: 1 };
        }
        this.sessions.delete(id);
        if (this.stateDir)
            this.persistState();
        return { stdout: `killed ${id}\n`, stderr: "", exitCode: 0 };
    }
    handleExport(id, targetPath) {
        const sess = this.sessions.get(id);
        if (!sess) {
            return { stdout: "", stderr: `session not found: ${id}\n`, exitCode: 1 };
        }
        writeFileSync(targetPath, JSON.stringify(sess, null, 2));
        return { stdout: `exported ${id} to ${targetPath}\n`, stderr: "", exitCode: 0 };
    }
    handleResume(id, prompt, approvalMode, cwd) {
        // Validate
        if (!SESSION_ID_RE.test(id)) {
            return { stdout: "", stderr: `bad session id: ${id}\n`, exitCode: 2 };
        }
        if (this.expectedSessionIds && !this.expectedSessionIds.includes(id)) {
            return { stdout: "", stderr: `unexpected session id: ${id}\n`, exitCode: 2 };
        }
        if (approvalMode && !this.allowedApprovalModes.includes(approvalMode)) {
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
        if (this.stateDir)
            this.persistState();
        return { stdout: response, stderr: "", exitCode: 0 };
    }
    handleOneShot(prompt, approvalMode, _cwd) {
        if (approvalMode && !this.allowedApprovalModes.includes(approvalMode)) {
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
    stateFile() {
        if (!this.stateDir)
            throw new Error("stateDir not set");
        return join(this.stateDir, "_state.json");
    }
    loadState() {
        const p = this.stateFile();
        if (!existsSync(p))
            return;
        try {
            const data = JSON.parse(readFileSync(p, "utf8"));
            for (const s of data.sessions)
                this.sessions.set(s.id, s);
            if (this.verbose)
                this.log(`loaded ${data.sessions.length} sessions from state`);
        }
        catch {
            // Corrupt state; ignore
        }
    }
    persistState() {
        if (!this.stateDir)
            return;
        if (!existsSync(this.stateDir))
            mkdirSync(this.stateDir, { recursive: true });
        writeFileSync(this.stateFile(), JSON.stringify({ sessions: Array.from(this.sessions.values()) }, null, 2));
    }
    // ==========================================================================
    // Helpers
    // ==========================================================================
    log(msg) {
        process.stderr.write(`[fake-dsh] ${msg}\n`);
    }
}
function parseArgs(argv) {
    const out = {
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
                if (v !== undefined)
                    out.sessionId = v;
                break;
            }
            case "--prompt": {
                const v = argv[++i];
                if (v !== undefined)
                    out.prompt = v;
                break;
            }
            case "--kill-session": {
                const v = argv[++i];
                if (v !== undefined)
                    out.killSession = v;
                break;
            }
            case "--export": {
                const v = argv[++i];
                if (v !== undefined)
                    out.exportTo = v;
                break;
            }
            case "--approval-mode": {
                const v = argv[++i];
                if (v !== undefined)
                    out.approvalMode = v;
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
