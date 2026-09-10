# Changelog

All notable changes to dsh-cli-mcp are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-09-10

First full release. Implements all 11 features of the `lib v1` contract shared
with mcode-mcp, qwen-cli-mcp, grok-cli-mcp, kimi-cli-mcp and pi-cli-mcp.

### Added

- **7 MCP tools:**
  - `dsh` — one-shot prompt (Tier 1)
  - `dsh_reply` — resume a session (Tier 1: session-resume)
  - `dsh_models` — list available models (Tier 1: discovery-model-list)
  - `dsh_sessions` — list sessions, export to JSON (Tier 1+3)
  - `dsh_running` — show active runs (helper)
  - `dsh_send` — mid-run control: abort / steer / kill (Tier 3)
  - `dsh_history` — full session transcript (Tier 2: observability-session-replay)
- **`lib/`** — shared core: session-store, process-runner, semaphore,
  binary-resolver, errors, config, logger
- **State persistence** — per-session JSON files in `DSH_MCP_STATE_DIR`
  (default `~/.dsh-cli-mcp/state/`), with LRU prune
- **Concurrency control** — slot-semaphore (`DSH_MCP_MAX_CONCURRENT`, default 4)
- **Cancellation** — cooperative (AbortController) + signal-fallback
  (SIGTERM → 5s grace → SIGKILL on own process group)
- **Configuration** — all via env vars (see README)
- **Tests** — 20 tests (10 unit + 10 integration with a fake `dsh` binary);
  `pnpm test:live` for end-to-end against the real CLI
- **CI workflow** — GitHub Actions (lint + typecheck + test on Node 22 and 24)
- **Documentation** — README, SPEC, FEATURES matrix, CHANGELOG

### Features matrix (lib v1, all 11 present)

| Feature | Tier | Implemented |
|---------|------|-------------|
| `transport-stdio` | T1 | ✅ |
| `session-list` | T1 | ✅ |
| `session-resume` | T1 | ✅ |
| `discovery-model-list` | T1 | ✅ |
| `cancellation` | T2 | ✅ |
| `observability-session-replay` | T2 | ✅ |
| `session-kill` | T3 | ✅ |
| `mid-run-abort` | T3 | ✅ |
| `mid-run-steer` | T3 | ✅ |
| `sub-transport-acp` | T3 | ✅ (transport interface; full ACP wire protocol is CLI's job) |
| `approval-mode` | T3 | ✅ (config + lib API) |
| `session-export` | T3 | ✅ |
| `discovery-tool-list` | opt | ✅ |

## [0.1.0] — 2026-09-10

Initial scaffold. Single tool (`dsh`), no lib, no sessions.

- TypeScript ESM, strict mode
- MCP stdio transport (2025-06-18)
- One `dsh` tool spawning `dsh --print`
- biome for lint, vitest for tests
- README + LICENSE (MIT)
