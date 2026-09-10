// Subprocess management for the wrapped `dsh` CLI.
//
// This module is intentionally tiny for v0.1.0: one helper, `runDsh`, that
// spawns a single `dsh --print` process, captures stdout / stderr, enforces a
// wall-clock timeout, and resolves with a `DshRunResult`. No sessions, no
// streaming, no mid-run control — those are later cycles.

import { spawn } from "node:child_process";
import { DshExitError, DshTimeoutError, InvalidArgumentError } from "./lib/errors.ts";

/** Maximum number of bytes we are willing to buffer per stream. */
export const MAX_CAPTURE = 16_000_000;

/** How many trailing bytes of stderr we keep around for diagnostics. */
export const MAX_STDERR = 4_096;

/** Default wall-clock cap. Callers can override via `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Hard ceiling on `timeout_ms` — 30 minutes. */
export const MAX_TIMEOUT_MS = 1_800_000;

/** Default binary name on `PATH`; override with the `DSH_MCP_BIN` env var. */
export const DSH_BIN = process.env.DSH_MCP_BIN ?? "dsh";

export interface RunDshOptions {
  /** Working directory of the child process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Wall-clock timeout in ms. Defaults to 300 000 (5 min). */
  timeoutMs?: number;
  /** Extra env vars to add on top of `process.env`. */
  extraEnv?: Record<string, string>;
}

export interface RunDshArgs {
  /** The prompt string passed verbatim as the only positional arg. */
  prompt: string;
  options?: RunDshOptions;
}

/**
 * Spawn `dsh --print "<prompt>"`, wait for it to finish, and resolve with
 * the captured output. Throws `DshTimeoutError` on wall-clock timeout or
 * `DshExitError` on a non-zero exit code.
 */
export function runDsh({ prompt, options }: RunDshArgs): Promise<import("./types.ts").DshRunResult> {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return Promise.reject(new InvalidArgumentError("`prompt` must be a non-empty string"));
  }
  if (options?.cwd !== undefined && !isAbsolute(options.cwd)) {
    return Promise.reject(new InvalidArgumentError("`cwd` must be an absolute path"));
  }
  const timeoutMs = clampTimeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const cwd = options?.cwd ?? process.cwd();
  const env = { ...process.env, ...(options?.extraEnv ?? {}) };
  const args = ["--print", prompt];

  return new Promise((resolve, reject) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settle: (value: import("./types.ts").DshRunResult) => void;
    let settled = false;
    const finish = (result: import("./types.ts").DshRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(DSH_BIN, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      reject(new Error(`failed to spawn ${DSH_BIN}: ${(err as Error).message}`));
      return;
    }

    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already dead.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      // SIGKILL after 5 s if dsh refuses to die.
      setTimeout(() => signalTree("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.on("error", (err: Error) => {
      finish({
        code: -1,
        stdout,
        stderr: trimTail(`${stderr}\n${DSH_BIN}: ${err.message}`),
        wallMs: Date.now() - start,
        command: DSH_BIN,
        args,
      });
    });
    child.on("close", (code: number | null) => {
      const result: import("./types.ts").DshRunResult = {
        code: code ?? -1,
        stdout,
        stderr: trimTail(stderr),
        wallMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
        command: DSH_BIN,
        args,
      };
      finish(result);
    });

    settle = (result) => {
      if (timedOut) {
        reject(new DshTimeoutError(timeoutMs, `dsh did not finish within ${timeoutMs} ms`));
        return;
      }
      if (result.code !== 0) {
        reject(new DshExitError(result.code, `dsh exited with code ${result.code}`));
        return;
      }
      resolve(result);
    };
  });
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE) return current;
  return current + chunk.slice(0, MAX_CAPTURE - current.length);
}

function trimTail(text: string): string {
  if (text.length <= MAX_STDERR) return text;
  return text.slice(text.length - MAX_STDERR);
}

function clampTimeout(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1_000) return DEFAULT_TIMEOUT_MS;
  if (requested > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(requested);
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}
