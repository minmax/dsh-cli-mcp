# dsh-cli-mcp

[![status](https://img.shields.io/badge/status-v1.0.0-green.svg)](#)
[![MCP protocol](https://img.shields.io/badge/MCP-2025--06--18-blue.svg)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

MCP server that delegates coding tasks to your **locally installed**
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI (`dsh`,
npm package `@deepseek-ai/dsh`).

`dsh-cli-mcp` is built on the `lib v1` shared with the five sibling
[adapters](#sibling-adapters). It exposes **7 MCP tools** that cover the full
contract of the unified CLI-delegator pattern: prompt, sessions, model-list,
mid-run control, transcript replay, and structured export.

## What it does

| Tool | Tier | What |
|------|------|------|
| `dsh` | T1 | Run a one-shot prompt through the wrapped `dsh` CLI |
| `dsh_reply` | T1 | Continue a persistent session by id |
| `dsh_models` | T1 | List models the wrapped CLI knows about |
| `dsh_sessions` | T1+3 | List persistent sessions / export a session to JSON |
| `dsh_running` | helper | Show which sessions are currently active |
| `dsh_send` | T3 | abort / steer / kill a running session |
| `dsh_history` | T2 | Get the full transcript of a session |

All 11 lib v1 features are implemented — see
[docs/FEATURES.md](docs/FEATURES.md) for the complete matrix, and
[docs/REVIEW.md](docs/REVIEW.md) for the self-audit (every claimed feature
verified against the code).

## Install

```bash
npx -y dsh-cli-mcp          # no install
npm install -g dsh-cli-mcp  # or global
```

Requires Node >= 22 and a working `dsh` on `PATH`
(`npm i -g @deepseek-ai/dsh` or `pnpm add -g @deepseek-ai/dsh`).

To point the adapter at a non-PATH binary without changing global `PATH`:

```bash
export DSH_MCP_BIN=/path/to/dsh
# (also accepts DSH_BINARY as the canonical name)
```

## Use with Claude Code / Cursor

```bash
claude mcp add-json dsh -s user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "dsh-cli-mcp"],
  "timeout": 3600000
}'
```

For Cursor / Windsurf / other MCP hosts, point the stdio command at
`npx -y dsh-cli-mcp` (or your globally-installed `dsh-cli-mcp`).

## Quick example

From any MCP client (the host will hide the JSON-RPC plumbing):

```text
# One-shot prompt
host.tool_call("dsh", {
  prompt: "Write a Python function that returns the n-th Fibonacci number. " +
          "Include type hints and a docstring. Save to fib.py."
})

# Continue a session
host.tool_call("dsh_reply", {
  session_id: "abc12345",
  prompt: "Also add a test for the negative-n case."
})

# Mid-run control
host.tool_call("dsh_send", {
  session_id: "abc12345",
  command: "abort"
})
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DSH_MCP_BIN` / `DSH_BINARY` | `dsh` (on `PATH`) | Override the wrapped-CLI binary path |
| `DSH_MCP_STATE_DIR` | `~/.dsh-cli-mcp/state` | Where session state files live |
| `DSH_MCP_MAX_CONCURRENT` | `4` | Max concurrent CLI runs (slot-semaphore) |
| `DSH_MCP_TRANSPORT` | `acp` | Sub-transport: `acp` (default) or `print` |
| `DSH_MCP_APPROVAL` | `default` | Default approval mode: `yolo` / `default` / `auto` / `plan` |
| `DSH_MCP_CALL_TIMEOUT_MS` | `300000` (5 min) | Per-call timeout |
| `DSH_MCP_SERVER_TIMEOUT_MS` | `1800000` (30 min) | Hard ceiling on timeout |
| `DSH_MCP_MAX_OUTPUT_BYTES` | `50 MB` | Max captured stdout per call |
| `DSH_MCP_ALLOWED_MODELS` | (all) | Comma-separated allow-list of model ids |
| `DEEPSEEK_API_KEY` etc. | — | Inherited from wrapped CLI's auth |

`dsh-cli-mcp` does **not** manage DeepSeek auth itself — it passes the user's
`process.env` through to the wrapped CLI, so any auth env-var the user has set
will be honored.

## How it works

```
MCP host  ──stdio/JSON-RPC──>  dsh-cli-mcp  ──child_process──>  dsh CLI
                                  │
                                  └──file-based──>  state dir (sessions, history)
```

Every tool call goes through the same pipeline:

1. **Resolve CLI** — `DSH_MCP_BIN` > `DSH_BINARY` > `PATH` lookup > common
   locations. Fails fast with `binary_not_found` if nothing is found.
2. **Acquire semaphore slot** — prevents runaway spawns (default max 4).
3. **Spawn process** — with the user's `cwd`, env, optional timeout and
   `AbortController`. Own process group, so SIGTERM/SIGKILL can clean up
   the whole tree.
4. **Stream / buffer** — `dsh` tool buffers; `dsh_reply` streams to
   subscribers via `SessionEvent` callback.
5. **Persist** — `dsh_reply` updates the per-session JSON file in
   `DSH_MCP_STATE_DIR`.

## Architecture

```
src/
├── server.ts                    # MCP server entry point
├── cli.ts                       # Legacy v0.1.0 spawn helper (kept for dsh tool)
├── types.ts                     # Shared MCP wire types
├── lib/
│   ├── lib-spec.ts              # 11 lib v1 features (TypeScript interfaces)
│   ├── lib.ts                   # Lib facade: wires everything together
│   ├── session-store.ts         # File-based session persistence + LRU prune
│   ├── process-runner.ts        # Spawn CLI with cancellation + timeout
│   ├── semaphore.ts             # Concurrency slot limiter
│   ├── binary.ts                # CLI binary resolution
│   ├── errors.ts                # Typed error hierarchy
│   ├── config.ts                # Env-driven config
│   └── logger.ts                # Stderr-only logger (stdout is MCP wire)
└── tools/
    ├── dsh.ts                   # One-shot prompt
    ├── dsh-reply.ts             # Resume session
    ├── dsh-models.ts            # List models
    ├── dsh-sessions.ts          # List + export sessions
    ├── dsh-running.ts           # Active runs
    ├── dsh-send.ts              # abort / steer / kill
    └── dsh-history.ts           # Get transcript
```

The `lib/` directory is the cross-adapter contract. The `tools/` directory is
the MCP glue — each tool is a thin adapter that parses args, calls `lib`, and
formats the result. **For a new wrapped-CLI adapter, copy `tools/`, swap the
binary name, and you have a new adapter.**

## Sibling adapters

`dsh-cli-mcp` is one of six adapters that all share the same `lib v1`
contract:

- [mcode-mcp](https://github.com/minmax/mcode-mcp) — wraps the mcode CLI
- [qwen-cli-mcp](https://github.com/minmax/qwen-cli-mcp) — wraps the Qwen Code CLI
- [grok-code-mcp](https://github.com/minmax/grok-code-mcp) — wraps the grok CLI
- [kimi-cli-mcp](https://github.com/minmax/kimi-cli-mcp) — wraps kimi-code (the
  richest reference implementation; 5 sub-mechanisms for cancellation alone)
- [pi-cli-mcp](https://github.com/minmax/pi-cli-mcp) — wraps the pi CLI

For the full design rationale, see
[cli-mcp-lib](https://github.com/minmax/cli-mcp-lib) (coming soon).

## Development

```bash
git clone https://github.com/minmax/dsh-cli-mcp
cd dsh-cli-mcp
pnpm install      # or npm install
pnpm build        # compiles to dist/
pnpm test         # runs 20 tests (10 unit + 10 integration)
pnpm test:live    # runs integration tests against the real dsh binary
pnpm check        # biome lint + tsc --noEmit
```

Live tests require `DSH_CLI_MCP_LIVE=1` and a working `dsh` CLI; the default
test suite uses a tiny shell-script fake that implements the subset of the
`dsh` surface the lib exercises.

## License

[MIT](LICENSE) © Karataev Pavel.
