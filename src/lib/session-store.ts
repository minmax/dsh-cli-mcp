/**
 * lib session-store — file-based persistence для sessions + state.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./config.js";
import { LibError, SessionNotFoundError } from "./errors.js";
import type { SessionInfo } from "./lib-spec.js";
import { SlotSemaphore } from "./semaphore.js";

interface StateFile {
  version: 1;
  info: SessionInfo;
  transcript: Array<{ role: "user" | "assistant" | "system"; content: string; at: string }>;
}

export class SessionStore {
  private readonly mutexes = new Map<string, SlotSemaphore>();
  private readonly indexLock: SlotSemaphore;
  private readonly cache = new Map<string, StateFile>();
  private readonly maxSessions: number;
  private readonly stateDirResolved: string;

  constructor(stateDir: string = STATE_DIR, maxSessions = 100) {
    this.stateDirResolved = stateDir;
    this.maxSessions = maxSessions;
    this.indexLock = new SlotSemaphore(1);
    if (!existsSync(this.stateDirResolved)) {
      mkdirSync(this.stateDirResolved, { recursive: true });
    }
  }

  async create(opts: { cwd: string; modelId?: string; initialPrompt: string }): Promise<SessionInfo> {
    return this.createWithId(randomUUID().slice(0, 8), opts);
  }

  /** Create a session with a specific id (used when CLI provides the id). */
  async createWithId(id: string, opts: { cwd: string; modelId?: string; initialPrompt: string }): Promise<SessionInfo> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new LibError("invalid_session_id", `Bad session id: ${id}`, "user", { sessionId: id });
    }
    const release = await this.indexLock.acquire();
    try {
      const now = new Date().toISOString();
      const info: SessionInfo = {
        id,
        createdAt: now,
        lastUsedAt: now,
        cwd: resolve(opts.cwd),
        ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
        summary: opts.initialPrompt.slice(0, 120),
        messageCount: 0,
      };
      const state: StateFile = {
        version: 1,
        info,
        transcript: [{ role: "user", content: opts.initialPrompt, at: now }],
      };
      this.writeState(info.id, state);
      this.cache.set(info.id, state);
      this.pruneLru();
      return info;
    } finally {
      release();
    }
  }

  async get(sessionId: string): Promise<SessionInfo> {
    const state = await this.loadState(sessionId);
    return state.info;
  }

  async list(): Promise<SessionInfo[]> {
    const release = await this.indexLock.acquire();
    try {
      const ids = this.listStateFiles();
      const sessions: SessionInfo[] = [];
      for (const id of ids) {
        try {
          const state = this.loadStateSync(id);
          sessions.push(state.info);
        } catch {
          // skip corrupted
        }
      }
      sessions.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
      return sessions;
    } finally {
      release();
    }
  }

  async touch(sessionId: string, userPrompt: string, assistantResponse: string): Promise<void> {
    const release = await this.sessionMutex(sessionId).acquire();
    try {
      const state = await this.loadState(sessionId);
      const now = new Date().toISOString();
      state.info = {
        ...state.info,
        lastUsedAt: now,
        messageCount: state.info.messageCount + 2,
        summary: userPrompt.slice(0, 120),
      };
      state.transcript.push({ role: "user", content: userPrompt, at: now });
      state.transcript.push({ role: "assistant", content: assistantResponse, at: now });
      this.writeState(sessionId, state);
    } finally {
      release();
    }
  }

  sessionMutex(sessionId: string): SlotSemaphore {
    let m = this.mutexes.get(sessionId);
    if (!m) {
      m = new SlotSemaphore(1);
      this.mutexes.set(sessionId, m);
    }
    return m;
  }

  async kill(sessionId: string): Promise<void> {
    const release = await this.indexLock.acquire();
    try {
      const path = this.statePath(sessionId);
      if (!existsSync(path)) {
        throw new SessionNotFoundError(sessionId);
      }
      unlinkSync(path);
      this.cache.delete(sessionId);
      this.mutexes.delete(sessionId);
    } finally {
      release();
    }
  }

  async exportTo(sessionId: string, targetPath: string): Promise<void> {
    const state = await this.loadState(sessionId);
    writeFileSync(targetPath, JSON.stringify(state, null, 2));
  }

  async getState(sessionId: string): Promise<StateFile> {
    return this.loadState(sessionId);
  }

  private statePath(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new LibError("invalid_session_id", `Bad session id: ${id}`, "user", { sessionId: id });
    }
    return join(this.stateDirResolved, `${id}.json`);
  }

  private writeState(id: string, state: StateFile): void {
    const path = this.statePath(id);
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  private listStateFiles(): string[] {
    if (!existsSync(this.stateDirResolved)) return [];
    return readdirSync(this.stateDirResolved)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  private loadStateSync(id: string): StateFile {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const path = this.statePath(id);
    if (!existsSync(path)) {
      throw new SessionNotFoundError(id);
    }
    const raw = readFileSync(path, "utf8");
    const state = JSON.parse(raw) as StateFile;
    if (state.version !== 1) {
      throw new LibError("state_version_mismatch", `Unknown state version: ${String(state.version)}`, "internal", {
        id,
      });
    }
    this.cache.set(id, state);
    return state;
  }

  private async loadState(id: string): Promise<StateFile> {
    return this.loadStateSync(id);
  }

  private pruneLru(): void {
    if (this.maxSessions <= 0) return;
    const ids = this.listStateFiles();
    if (ids.length <= this.maxSessions) return;
    const withMtime = ids
      .map((id) => ({ id, mtime: statSync(this.statePath(id)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    const toDelete = withMtime.slice(0, ids.length - this.maxSessions);
    for (const { id } of toDelete) {
      try {
        unlinkSync(this.statePath(id));
      } catch {
        // ignore
      }
      this.cache.delete(id);
    }
  }
}
