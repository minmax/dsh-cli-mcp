/**
 * fake-dsh CLI shim.
 *
 * This is the binary that gets spawned by lib/dsh-cli-mcp when tests set
 * DSH_MCP_BIN to point at this file. It parses argv + env, calls
 * FakeDsh.handle(), and writes the result to stdout/stderr.
 *
 * The actual "intelligence" lives in test/fake-dsh.ts. This file is a thin
 * transport.
 */

import { FakeDsh } from "./fake-dsh.js";

const stateDir = process.env["FAKE_STATE_DIR"];
const verbose = process.env["FAKE_VERBOSE"] === "1";
const failNext = process.env["FAKE_FAIL_NEXT"];
const sleepMs = Number(process.env["FAKE_SLEEP_MS"] ?? 0);

const opts: {
  models?: unknown;
  sleepMs?: number;
  failNext?: { exitCode: number; stderr: string };
  verbose?: boolean;
  allowedApprovalModes?: unknown;
  expectedSessionIds?: string[];
  stateDir?: string;
} = { verbose, sleepMs };
if (stateDir) opts.stateDir = stateDir;
if (failNext) {
  const idx = failNext.indexOf(":");
  const codeStr = idx >= 0 ? failNext.slice(0, idx) : failNext;
  const stderrText = idx >= 0 ? failNext.slice(idx + 1) : "";
  opts.failNext = { exitCode: Number(codeStr || 1), stderr: `${stderrText}\n` };
}

const fake = new FakeDsh(opts as ConstructorParameters<typeof FakeDsh>[0]);
const result = await fake.handle(process.argv.slice(2), process.env, process.cwd());
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
