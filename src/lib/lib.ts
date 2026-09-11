/**
 * lib facade — реализация LibV1 (11 v1 фич) поверх ProcessRunner + SessionStore.
 *
 * Это тонкая обёртка: вся фактическая работа — в специализированных классах.
 */
import { randomUUID } from "node:crypto";
import { resolveBinary } from "./binary.js";
import { loadConfig } from "./config.js";
import { InvalidArgumentError, LibError } from "./errors.js";
import type {
  AcpEvent,
  AcpRequest,
  ApprovalMode,
  LibConfig,
  LibV1,
  ModelInfo,
  SessionEvent,
  SessionInfo,
} from "./lib-spec.js";
import { warn } from "./logger.js";
import { ProcessRunner } from "./process-runner.js";
import { SlotSemaphore } from "./semaphore.js";
import { SessionStore } from "./session-store.js";

export class Lib implements LibV1 {
  // From StdioTransport
  public readonly protocolVersion = "2025-06-18";
  public readonly serverName: string;
  public readonly serverVersion: string;

  // State
  private readonly config: LibConfig;
  private readonly runner: ProcessRunner;
  private readonly store: SessionStore;
  private readonly semaphore: SlotSemaphore;
  private currentApprovalMode: ApprovalMode;
  private readonly eventSubscribers = new Map<string, Set<(e: SessionEvent) => void>>();
  private running = false;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(serverName: string, serverVersion: string, config?: Partial<LibConfig>) {
    this.config = { ...loadConfig(), ...config } as LibConfig;
    this.serverName = serverName;
    this.serverVersion = serverVersion;
    this.runner = new ProcessRunner(this.config);
    this.store = new SessionStore(this.config.stateDir);
    this.semaphore = new SlotSemaphore(this.config.maxConcurrent);
    this.currentApprovalMode = this.config.defaultApprovalMode;
  }

  // ===========================================================================
  // StdioTransport
  // ===========================================================================

  async start(): Promise<void> {
    if (this.running) {
      throw new LibError("already_running", "Lib already started", "protocol");
    }
    this.running = true;
    // Проверяем что CLI binary доступен
    try {
      resolveBinary({
        binary: this.config.cliBinary,
        envVar: `${this.config.cliBinary.toUpperCase()}_BINARY`,
      });
    } catch (err) {
      warn("CLI binary not found at start", { err: String(err) });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // Kill все активные runs
    for (const ctrl of this.activeRuns.values()) {
      ctrl.abort();
    }
    this.activeRuns.clear();
  }

  // ===========================================================================
  // session-list
  // ===========================================================================

  async listSessions(): Promise<SessionInfo[]> {
    this.assertRunning();
    // Call the wrapped CLI's --list-sessions (if it supports it) to get any
    // remote sessions, then merge with local state. For now, just return local.
    // The CLI is allowed to take a while if sessions are remote.
    void this.runner; // future: cross-reference with CLI's list
    return this.store.list();
  }

  // ===========================================================================
  // session-resume
  // ===========================================================================

  async resumeSession(sessionId: string, prompt: string): Promise<string> {
    this.assertRunning();
    this.assertValidPrompt(prompt);
    // Use the provided session id verbatim (CLI is source of truth for session identity).
    // If lib doesn't have state for it yet, create a placeholder so the rest of the
    // pipeline (touch, kill, export) can find it.
    let info: SessionInfo;
    try {
      info = await this.store.get(sessionId);
    } catch {
      info = await this.store.createWithId(sessionId, { cwd: process.cwd(), initialPrompt: prompt });
    }

    const release = await this.semaphore.acquire();
    const abort = new AbortController();
    this.activeRuns.set(info.id, abort);
    const subEvents: SessionEvent[] = [];
    let responseBuf = "";

    try {
      // Resume: запускаем CLI с --session и --prompt
      const args = [
        ...this.config.defaultArgs,
        "--session",
        info.id,
        "--prompt",
        prompt,
        "--approval-mode",
        this.currentApprovalMode,
      ];
      const res = await this.runner.run({
        args,
        cwd: info.cwd,
        timeoutMs: this.config.callTimeoutMs,
        signal: abort,
        onStdoutChunk: (chunk) => {
          responseBuf += chunk;
          subEvents.push({ type: "assistant-text", content: chunk, at: new Date().toISOString() });
          this.notifySubscribers(info.id, { type: "assistant-text", content: chunk, at: new Date().toISOString() });
        },
      });

      const response = responseBuf || res.stdout;
      await this.store.touch(info.id, prompt, response);
      this.notifySubscribers(info.id, { type: "session-end", reason: "completed", at: new Date().toISOString() });
      return response;
    } catch (err) {
      this.notifySubscribers(info.id, {
        type: "error",
        message: (err as Error).message,
        at: new Date().toISOString(),
      });
      this.notifySubscribers(info.id, { type: "session-end", reason: "errored", at: new Date().toISOString() });
      throw err;
    } finally {
      release();
      this.activeRuns.delete(info.id);
    }
  }

  // ===========================================================================
  // discovery-model-list
  // ===========================================================================

  async listModels(): Promise<ModelInfo[]> {
    this.assertRunning();
    const release = await this.semaphore.acquire();
    try {
      // Call without defaultArgs (--print) because --list-models is its own subcommand
      const res = await this.runner.run({
        args: ["--list-models"],
        timeoutMs: 30_000,
      });
      return parseModels(res.stdout, this.config.allowedModels);
    } finally {
      release();
    }
  }

  // ===========================================================================
  // cancellation
  // ===========================================================================

  setupCancellation(): AbortController {
    return new AbortController();
  }

  async terminateProcess(pid: number): Promise<void> {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // уже мёртв
    }
    await new Promise((r) => setTimeout(r, 1000));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ok
    }
  }

  // ===========================================================================
  // observability-session-replay
  // ===========================================================================

  subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
    let subs = this.eventSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.eventSubscribers.set(sessionId, subs);
    }
    subs.add(onEvent);
    return () => {
      subs?.delete(onEvent);
      if (subs && subs.size === 0) {
        this.eventSubscribers.delete(sessionId);
      }
    };
  }

  private notifySubscribers(sessionId: string, event: SessionEvent): void {
    const subs = this.eventSubscribers.get(sessionId);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(event);
      } catch (err) {
        warn("subscriber error", { err: String(err) });
      }
    }
  }

  // ===========================================================================
  // session-kill
  // ===========================================================================

  async killSession(sessionId: string): Promise<void> {
    this.assertRunning();
    // Сначала остановить активный run если есть
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.abort();
    }
    // Best-effort: послать CLI команду kill
    try {
      const release = await this.semaphore.acquire(5_000);
      try {
        await this.runner.run({
          args: [...this.config.defaultArgs, "--kill-session", sessionId],
          timeoutMs: 5_000,
        });
      } finally {
        release();
      }
    } catch {
      // CLI может не поддерживать — ок, удаляем локально
    }
    // Удаляем state (don't fail if not present)
    try {
      await this.store.kill(sessionId);
    } catch {
      // session not in local store, ok
    }
    this.notifySubscribers(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  // ===========================================================================
  // mid-run-abort
  // ===========================================================================

  async abortRun(sessionId: string): Promise<void> {
    this.assertRunning();
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.abort();
    }
    // Также пошлём CLI команду abort
    try {
      const release = await this.semaphore.acquire(5_000);
      try {
        await this.runner.run({
          args: [...this.config.defaultArgs, "--session", sessionId, "--abort"],
          timeoutMs: 5_000,
        });
      } finally {
        release();
      }
    } catch {
      // ок
    }
    this.notifySubscribers(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  // ===========================================================================
  // mid-run-steer
  // ===========================================================================

  async steerRun(sessionId: string, newPrompt: string): Promise<void> {
    this.assertRunning();
    this.assertValidPrompt(newPrompt);
    // 1. abort текущего run
    await this.abortRun(sessionId);
    // 2. продолжить с новым промптом
    await this.resumeSession(sessionId, newPrompt);
  }

  // ===========================================================================
  // sub-transport-acp (read-only façade)
  // ===========================================================================

  get name(): "acp" | "print" | "rpc" {
    const env = process.env[this.config.transportEnvVar];
    if (env === "print" || env === "rpc") return env;
    return this.config.defaultTransport;
  }

  async *send(request: AcpRequest): AsyncIterable<AcpEvent> {
    this.assertRunning();
    // Default: convert to CLI args + spawn, yield stdout chunks
    const args = [...this.config.defaultArgs, JSON.stringify(request)];
    const release = await this.semaphore.acquire();
    try {
      const result = await this.runner.run({
        args,
        timeoutMs: this.config.callTimeoutMs,
      });
      yield { type: "init", payload: { ok: true } };
      yield { type: "message", payload: result.stdout };
      yield { type: "done", payload: { exitCode: result.exitCode } };
    } finally {
      release();
    }
  }

  // ===========================================================================
  // approval-mode
  // ===========================================================================

  getApprovalMode(): ApprovalMode {
    return this.currentApprovalMode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.currentApprovalMode = mode;
  }

  // ===========================================================================
  // session-export
  // ===========================================================================

  async exportSession(sessionId: string, targetPath: string): Promise<void> {
    this.assertRunning();
    return this.store.exportTo(sessionId, targetPath);
  }

  // ===========================================================================
  // discovery-tool-list (opt)
  // ===========================================================================

  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [
      { name: "dsh", description: "Send a prompt to dsh CLI", inputSchema: { type: "object" } },
      { name: "dsh_reply", description: "Reply to existing session", inputSchema: { type: "object" } },
      { name: "dsh_models", description: "List available models", inputSchema: { type: "object" } },
      { name: "dsh_sessions", description: "List persistent sessions", inputSchema: { type: "object" } },
      { name: "dsh_running", description: "List active runs", inputSchema: { type: "object" } },
      { name: "dsh_send", description: "Send command to running session", inputSchema: { type: "object" } },
      { name: "dsh_history", description: "Get session history", inputSchema: { type: "object" } },
    ];
  }

  // ===========================================================================
  // Helpers (доступно для адаптеров)
  // ===========================================================================

  /** Список активных run'ов (snapshot). */
  listActiveRuns(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  /** Создать новую сессию и сразу сделать первый прогон. */
  async newSession(opts: {
    cwd: string;
    prompt: string;
    modelId?: string;
  }): Promise<{ session: SessionInfo; response: string }> {
    this.assertRunning();
    this.assertValidPrompt(opts.prompt);
    const session = await this.store.create({
      cwd: opts.cwd,
      ...(opts.modelId ? { modelId: opts.modelId } : {}),
      initialPrompt: opts.prompt,
    });
    const response = await this.resumeSession(session.id, opts.prompt);
    return { session, response };
  }

  /** Прямой запуск CLI (для dsh tool). */
  async invoke(
    args: readonly string[],
    opts?: { cwd?: string; timeoutMs?: number; signal?: AbortController },
  ): Promise<string> {
    this.assertRunning();
    const release = await this.semaphore.acquire();
    try {
      // Auto-inject --approval-mode so callers don't have to remember
      const fullArgs = [...this.config.defaultArgs, ...args, "--approval-mode", this.currentApprovalMode];
      const res = await this.runner.run({
        args: fullArgs,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        timeoutMs: opts?.timeoutMs ?? this.config.callTimeoutMs,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      return res.stdout;
    } finally {
      release();
    }
  }

  /** Доступ к store (для адаптеров). */
  get sessionStore(): SessionStore {
    return this.store;
  }

  /** ID для новой run если нужно (например, для activeRuns map). */
  newRunId(): string {
    return randomUUID();
  }

  /** Прямой доступ к approval mode. */
  get approvalMode(): ApprovalMode {
    return this.currentApprovalMode;
  }

  /** Конфиг (для адаптеров). */
  get libConfig(): LibConfig {
    return this.config;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private assertRunning(): void {
    if (!this.running) {
      throw new LibError("not_running", "Lib not started", "protocol");
    }
  }

  private assertValidPrompt(prompt: string): void {
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new InvalidArgumentError("prompt", "must be non-empty string");
    }
    if (prompt.length > 1_000_000) {
      throw new InvalidArgumentError("prompt", "exceeds 1MB");
    }
  }
}

function parseModels(stdout: string, allowed: ReadonlySet<string>): ModelInfo[] {
  // Expected format: JSON array of ModelInfo, или tab-separated (model id + display name)
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try JSON first
  try {
    const arr = JSON.parse(trimmed) as Array<{
      id: string;
      displayName?: string;
      provider?: string;
      contextWindow?: number;
      supportsTools?: boolean;
      supportsVision?: boolean;
    }>;
    if (Array.isArray(arr)) {
      return arr
        .filter((m) => m && typeof m.id === "string")
        .filter((m) => allowed.size === 0 || allowed.has(m.id))
        .map((m) => ({
          id: m.id,
          displayName: m.displayName ?? m.id,
          provider: m.provider ?? "unknown",
          contextWindow: m.contextWindow ?? 8192,
          supportsTools: m.supportsTools ?? false,
          supportsVision: m.supportsVision ?? false,
        }));
    }
  } catch {
    // fall through to text parsing
  }

  // Plain text: each line is "id\tdisplay name"
  return trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      const display = rest.join(" ").trim();
      if (!id) return null;
      return {
        id,
        displayName: display || id,
        provider: "unknown",
        contextWindow: 8192,
        supportsTools: false,
        supportsVision: false,
      };
    })
    .filter((m): m is ModelInfo => m !== null)
    .filter((m) => allowed.size === 0 || allowed.has(m.id));
}
