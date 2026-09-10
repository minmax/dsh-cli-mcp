# dsh-cli-mcp

[![status](https://img.shields.io/badge/status-preview-blue.svg)](#)

MCP server that delegates coding tasks to your **locally installed**
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI (`dsh`,
npm package `@deepseek-ai/dsh`).

It wraps the real `dsh` binary instead of bundling its own copy of the agent,
so every call inherits your DeepSeek login, models and config.

This is a minimal first scaffold. The wrapped CLI is invoked one-shot via
`dsh --print "<prompt>"`. Sessions, ACP transport, mid-run control, and the
`dsh web` UI integration are out of scope for v0.1.0 and will land in later
releases.

Sibling of
[mcode-mcp](https://github.com/minmax/mcode-mcp),
[qwen-cli-mcp](https://github.com/minmax/qwen-cli-mcp),
[kimi-cli-mcp](https://github.com/minmax/kimi-cli-mcp),
[pi-cli-mcp](https://github.com/minmax/pi-cli-mcp) and
[grok-code-mcp](https://github.com/minmax/grok-code-mcp) — same architecture,
same principles, DeepSeek Harness behind the wheel.

## Install

```bash
npx -y dsh-cli-mcp         # no install
npm install -g dsh-cli-mcp # or global
```

Requires Node >= 22 and a working `dsh` on `PATH`
(`npm i -g @deepseek-ai/dsh` or `pnpm add -g @deepseek-ai/dsh`).

To point the adapter at a non-PATH binary without changing global `PATH`:

```bash
export DSH_MCP_BIN=/path/to/dsh
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

Any other MCP client:

```json
{
  "mcpServers": {
    "dsh": { "command": "npx", "args": ["-y", "dsh-cli-mcp"] }
  }
}
```

Keep the server name short (`dsh`): it becomes part of the tool names your
model sees.

## Available tools

| Tool | Purpose |
|---|---|
| `dsh` | Run a prompt through DeepSeek Harness. Returns the final answer plus the exit code, wall time, and the last 4 KB of stderr. |

### `dsh`

| Argument | Notes |
|---|---|
| `prompt` | Required. The task for the DeepSeek Harness agent. Self-contained — `dsh` cannot see your conversation. |
| `cwd` | Optional absolute path. Defaults to the server's cwd. |
| `timeout_ms` | Optional integer, default 300 000 (5 min), max 1 800 000 (30 min). Wall-clock cap on the run. |

```js
dsh({
  prompt: "Reply with exactly: hello from dsh",
  cwd: "/abs/path/to/repo",
  timeout_ms: 120000,
})
```

The server spawns `dsh --print "<prompt>"` as a child process, waits for it
to finish, and returns one text block containing the prompt echo, the trimmed
stdout, the tail of stderr, the exit code, and the elapsed wall-clock time.

A non-zero exit code is reported as a tool error (`isError: true`) — the
adapter does not invent success where `dsh` itself returned failure.

## Development

```bash
git clone https://github.com/minmax/dsh-cli-mcp.git
cd dsh-cli-mcp
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

`pnpm run test:live` exercises the real `dsh` binary end-to-end
(`DSH_CLI_MCP_LIVE=1` opt-in). The default unit suite runs without `dsh` and
exercises the adapter's stdio JSON-RPC loop directly.

## License

MIT. See [LICENSE](./LICENSE).
