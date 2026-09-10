/**
 * lib process-runner — spawn wrapped-CLI process, handle IO + timeouts + cancel.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type ResolvedBinary, resolveBinary } from "./binary.js";
import { CliError, ProcessSpawnError, TimeoutError } from "./errors.js";
import type { LibConfig } from "./lib-spec.js";

export interface RunOptions {
  args: readonly string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortController;
  onStdoutChunk?: (chunk: string) => void;
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const PROTOCOL_LINE_RE = /^[<>:{}"]/;

export class ProcessRunner {
  private readonly config: LibConfig;
  constructor(config: LibConfig) {
    this.config = config;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const binary = resolveBinary({
      binary: this.config.cliBinary,
      envVar: `${this.config.cliBinary.toUpperCase()}_BINARY`,
    });
    const start = Date.now();
    const proc = this.spawnProc(binary, opts);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBytes = opts.maxOutputBytes ?? this.config.maxOutputBytes;

    return new Promise<RunResult>((resolve, reject) => {
      let killed = false;
      let killTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (killTimer) clearTimeout(killTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (opts.onStdoutChunk) {
          const s = chunk.toString("utf8");
          if (!PROTOCOL_LINE_RE.test(s)) {
            opts.onStdoutChunk(s);
          }
        } else {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            killed = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              // already dead
            }
            reject(
              new CliError(
                null,
                `Output exceeded max size (${maxBytes} bytes). Process killed.`,
                `spawn ${this.config.cliBinary}`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        errChunks.push(chunk);
      });

      proc.on("error", (err) => {
        cleanup();
        reject(new ProcessSpawnError(this.config.cliBinary, err));
      });

      proc.on("close", (code, sig) => {
        cleanup();
        const stdout = opts.onStdoutChunk ? "" : Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errChunks).toString("utf8");
        const exitCode = code ?? (sig ? -1 : 0);
        const durationMs = Date.now() - start;
        if (killed) {
          // The caller requested cancellation or the run was killed by us
          // (timeout / output-cap). Resolve with exitCode=-1 so the caller
          // sees a clean shutdown rather than a hang.
          resolve({ exitCode: -1, stdout, stderr, durationMs });
          return;
        }
        if (sig) {
          if (sig === "SIGTERM" || sig === "SIGKILL") {
            resolve({ exitCode: -1, stdout, stderr, durationMs });
            return;
          }
          reject(new CliError(exitCode, `Killed by ${sig}\n${stderr}`, `spawn ${this.config.cliBinary}`));
          return;
        }
        if (exitCode !== 0) {
          reject(new CliError(exitCode, stderr, `spawn ${this.config.cliBinary}`));
          return;
        }
        resolve({ exitCode, stdout, stderr, durationMs });
      });

      opts.signal?.signal.addEventListener("abort", () => {
        if (killed) return;
        killed = true;
        try {
          process.kill(-(proc.pid ?? 0), "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {
            // already dead
          }
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-(proc.pid ?? 0), "SIGKILL");
          } catch {
            try {
              proc.kill("SIGKILL");
            } catch {
              // already dead
            }
          }
        }, DEFAULT_KILL_GRACE_MS);
      });

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timeoutMs = opts.timeoutMs;
        timeoutTimer = setTimeout(() => {
          if (killed) return;
          killed = true;
          try {
            process.kill(-(proc.pid ?? 0), "SIGTERM");
          } catch {
            try {
              proc.kill("SIGTERM");
            } catch {
              // already dead
            }
          }
          killTimer = setTimeout(() => {
            try {
              process.kill(-(proc.pid ?? 0), "SIGKILL");
            } catch {
              // already dead
            }
          }, DEFAULT_KILL_GRACE_MS);
          reject(new TimeoutError(timeoutMs, `spawn ${this.config.cliBinary}`));
        }, timeoutMs);
      }
    });
  }

  private spawnProc(binary: ResolvedBinary, opts: RunOptions): ChildProcess {
    const allArgs = [...binary.prefix, binary.path, ...opts.args];
    const env = { ...process.env, ...(opts.env ?? {}) };

    const proc = spawn(allArgs[0]!, allArgs.slice(1), {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    if (opts.stdin !== undefined) {
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }

    return proc;
  }
}
