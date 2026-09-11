/**
 * lib binary — resolve CLI binary on PATH.
 *
 * Паттерн из kimi-cli-mcp: auto-resolve-on-PATH + env-var-override +
 * sandbox-wrap-prefix.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LibError } from "./errors.js";

export interface ResolveOptions {
  /** Имя бинаря (например "dsh") */
  binary: string;
  /** Env-var override (например "DSH_BINARY") */
  envVar?: string;
  /** Префикс для sandbox (например "bwrap" — будет "bwrap --ro-bind / dsh") */
  sandboxPrefix?: string;
}

export interface ResolvedBinary {
  /** Абсолютный путь к бинарю (если найден) */
  path: string;
  /** Префикс для запуска (sandbox или пустой) */
  prefix: string[];
  /** Args для env-var override (если есть) */
  env: NodeJS.ProcessEnv;
}

export function resolveBinary(opts: ResolveOptions): ResolvedBinary {
  // 1. Env-var override (try both the canonical name and the legacy DSH_MCP_BIN)
  const envVars = opts.envVar ? [opts.envVar, "DSH_MCP_BIN"] : ["DSH_MCP_BIN"];
  for (const envName of envVars) {
    if (process.env[envName]) {
      const p = process.env[envName];
      if (!p) throw new LibError("binary_not_found", `${envName} is set but empty`, "internal");
      if (!existsSync(p)) {
        throw new LibError("binary_not_found", `${envName} points to non-existent path: ${p}`, "user", { path: p });
      }
      return { path: p, prefix: opts.sandboxPrefix ? opts.sandboxPrefix.split(/\s+/) : [], env: { ...process.env } };
    }
  }

  // 2. Auto-resolve on PATH
  const which = spawnSync("which", [opts.binary], { encoding: "utf8" });
  if (which.status === 0) {
    const path = which.stdout.trim();
    if (path && existsSync(path)) {
      return {
        path,
        prefix: opts.sandboxPrefix ? opts.sandboxPrefix.split(/\s+/) : [],
        env: { ...process.env },
      };
    }
  }

  // 3. Common locations fallback
  const fallbacks = [
    `/usr/local/bin/${opts.binary}`,
    `/usr/bin/${opts.binary}`,
    `${process.env.HOME}/.local/bin/${opts.binary}`,
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) {
      return {
        path: p,
        prefix: opts.sandboxPrefix ? opts.sandboxPrefix.split(/\s+/) : [],
        env: { ...process.env },
      };
    }
  }

  throw new LibError(
    "binary_not_found",
    `Cannot find ${opts.binary} on PATH. Set ${opts.envVar ?? `${opts.binary.toUpperCase()}_BINARY`} to override.`,
    "user",
    { searched: fallbacks },
  );
}
