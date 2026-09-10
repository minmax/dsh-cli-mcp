# dsh-cli-mcp — Specification

> Wire-level spec for the seven MCP tools. Each tool is described in terms of
> its JSON-RPC input schema, output content, error cases, and side effects.

This document is normative. The implementation in `src/tools/*.ts` is the
reference. Any deviation between spec and code is a bug.

## Transport

- **Wire protocol:** MCP 2025-06-18 (with 2025-03-26 and 2024-11-05 fallback).
- **Server name:** `dsh-cli-mcp`
- **Server version:** semver, from `package.json`
- **Encoding:** UTF-8 JSON-RPC over stdio (one message per line on stdout)

## Concurrency model

- Up to `DSH_MCP_MAX_CONCURRENT` (default 4) concurrent CLI runs in flight.
- Additional calls block on a slot semaphore with the call timeout.
- Per-session lock: a second `dsh_reply` for the same session id waits on a
  per-session mutex until the first finishes.

## Error model

All errors are reported as `isError: true` text content with `[code] message`.
Codes are stable for programmatic handling:

| Code | When | Retryable |
|------|------|-----------|
| `binary_not_found` | DSH_MCP_BIN/DSH_BINARY and PATH both miss | no (user fix) |
| `process_spawn_failed` | spawn() threw | no |
| `cli_error` | wrapped-CLI exited non-zero | depends on context |
| `timeout` | per-call timeout exceeded | yes |
| `session_not_found` | `dsh_sessions.export` / `dsh_send kill` with unknown id | no |
| `invalid_argument` | bad input (missing prompt, bad id, etc.) | no |
| `state_version_mismatch` | state file from a future lib version | no |
| `internal_error` | lib invariant violation | no |

## Tool 1: `dsh`

**Tier 1: one-shot prompt (no session).**

Spawns `dsh --print "<prompt>"` (or whatever `DSH_MCP_DEFAULT_ARGS` is set to),
captures stdout, returns it as text.

### Input

```jsonc
{
  "prompt":          "string, required, 1..1_000_000 chars",
  "cwd":             "string, optional, absolute path",
  "timeout_ms":      "integer, optional, 1000..1_800_000, default 300_000"
}
```

### Output (success)

```jsonc
{
  "content": [
    { "type": "text", "text": "dsh completed.\n\n- command: dsh ...\n- exit_code: 0\n..." }
  ]
}
```

### Output (error)

`isError: true` with text `[code] message`.

## Tool 2: `dsh_reply`

**Tier 1+3: resume a session by id (or create if no local state).**

### Input

```jsonc
{
  "session_id": "string, required, [a-zA-Z0-9-]+",
  "prompt":     "string, required"
}
```

### Output (success)

```jsonc
{
  "content": [
    { "type": "text", "text": "session: <id>\n\n<assistant-response>" }
  ]
}
```

### Side effects

- If the lib has no local state for `session_id`, it creates a placeholder
  state file. The wrapped CLI is the source of truth for actual session
  content; the lib is the source of truth for tracking + observability.
- `stateDir/<session_id>.json` is updated with new messages, message count,
  and `lastUsedAt` timestamp.

## Tool 3: `dsh_models`

**Tier 1: list models the wrapped CLI can use.**

### Input

Empty object `{}`.

### Output (success)

```jsonc
{
  "content": [
    { "type": "text", "text": "3 model(s):\n\n- deepseek-chat\n    display: ...\n..." }
  ]
}
```

Models are filtered by `DSH_MCP_ALLOWED_MODELS` (comma-separated list). If
the wrapped CLI doesn't support `--list-models`, returns an empty list with
a note.

## Tool 4: `dsh_sessions`

**Tier 1+3: list sessions, or export one to a file.**

### Input

```jsonc
{
  "action":       "string, optional, 'list' (default) | 'export'",
  "session_id":   "string, required when action=export",
  "target_path":  "string, required when action=export, absolute path"
}
```

### Output (action=list)

```jsonc
{
  "content": [
    { "type": "text", "text": "<N> session(s):\n\n- <id>\n    cwd: ...\n..." }
  ]
}
```

### Output (action=export)

```jsonc
{
  "content": [
    { "type": "text", "text": "Session <id> exported to <path>" }
  ]
}
```

## Tool 5: `dsh_running`

**Helper: list currently active runs.**

### Input

Empty object `{}`.

### Output

```jsonc
{
  "content": [
    { "type": "text", "text": "<N> active run(s):\n\n- <session_id>\n..." }
  ]
}
```

A "run" is an in-flight `dsh_reply` that has not yet returned. The lib tracks
these so `dsh_send abort / steer` can target the right one.

## Tool 6: `dsh_send`

**Tier 3: mid-run control.**

### Input

```jsonc
{
  "session_id":  "string, required",
  "command":     "string, required, 'abort' | 'steer' | 'kill'",
  "prompt":      "string, required when command=steer"
}
```

### Semantics

| `command` | Effect |
|-----------|--------|
| `abort` | Cancel the current in-flight `dsh_reply`. Session is preserved. |
| `steer` | `abort` + immediately queue a new prompt. Session is preserved. |
| `kill` | `abort` + remove the session state file. Session is destroyed. |

All three are best-effort. The lib sends SIGTERM to the process group first
and SIGKILL after 5s if needed.

### Output

```jsonc
{
  "content": [
    { "type": "text", "text": "Session <id>: aborted | steered with new prompt | killed" }
  ]
}
```

## Tool 7: `dsh_history`

**Tier 2: full transcript of a session.**

### Input

```jsonc
{
  "session_id": "string, required"
}
```

### Output

```jsonc
{
  "content": [
    { "type": "text", "text": "Session <id>\n  cwd: ...\n  ...\n\n--- transcript ---\n[<at>] USER:\n<text>\n\n[<at>] ASSISTANT:\n<text>\n..." }
  ]
}
```

The transcript is local — it contains only what the lib has been told about.
The wrapped CLI is the source of truth for actual model output; this is a
mirror for replay and migration.

## Observability

The lib supports a `subscribe(sessionId, onEvent)` API for live event
streaming (used by tests; not currently exposed as a separate MCP tool).
Events are:

```ts
type SessionEvent =
  | { type: "user-prompt"; content: string; at: string }
  | { type: "assistant-text"; content: string; at: string }
  | { type: "tool-call"; name: string; args: unknown; at: string }
  | { type: "tool-result"; name: string; result: unknown; at: string }
  | { type: "error"; message: string; at: string }
  | { type: "session-end"; reason: "completed" | "killed" | "errored"; at: string };
```

## Versioning

- The MCP wire protocol version is fixed at server start.
- The state file format is versioned (currently `version: 1`). Newer versions
  reject older state files with `state_version_mismatch`.
- Tool signatures are semver-versioned. Adding a new tool is minor; changing
  an existing tool's input schema is major.

## Security

- No network access. The lib only spawns the configured CLI binary.
- All env vars are inherited from the parent process (the MCP host). Users
  should run the host with a minimal env.
- `DSH_MCP_ALLOWED_MODELS` is an enforceable allow-list. The lib filters at
  the list-source, not at call time, so an agent cannot bypass it via direct
  CLI args.
- `cwd` is validated to be absolute before passing to the child.
- Prompts are capped at 1 MB to prevent memory blowups.

## Non-goals

- Bundling the `dsh` binary. Users install `@deepseek-ai/dsh` separately.
- Remote / hosted model access. All calls go to the local CLI.
- Streaming partial responses. Currently `dsh_reply` buffers; live streaming
  is via the `subscribe` API (used by tests).
- OTel export. Deferred to lib v2.
