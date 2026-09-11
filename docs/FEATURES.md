# Feature matrix: dsh-cli-mcp v1

This document maps every feature in the `lib v1` contract to its
implementation in `dsh-cli-mcp`.

## 11 lib v1 features

| Feature | Tier | Implemented | File |
|---------|------|-------------|------|
| `transport-stdio` | T1 | ✅ | `src/server.ts` (StdioServerTransport) |
| `session-list` | T1 | ✅ | `src/tools/dsh-sessions.ts` |
| `session-resume` | T1 | ✅ | `src/tools/dsh-reply.ts` + `src/lib/lib.ts:resumeSession` |
| `discovery-model-list` | T1 | ✅ | `src/tools/dsh-models.ts` + `src/lib/lib.ts:listModels` |
| `cancellation` | T2 | ✅ | `src/lib/lib.ts:setupCancellation` + `src/lib/process-runner.ts` |
| `observability-session-replay` | T2 | ✅ | `src/lib/lib.ts:subscribe` + `src/tools/dsh-history.ts` |
| `session-kill` | T3 | ✅ | `src/tools/dsh-send.ts` + `src/lib/lib.ts:killSession` |
| `mid-run-abort` | T3 | ✅ | `src/tools/dsh-send.ts` + `src/lib/lib.ts:abortRun` |
| `mid-run-steer` | T3 | ✅ | `src/tools/dsh-send.ts` + `src/lib/lib.ts:steerRun` |
| `sub-transport-acp` | T3 | ✅ (interface) | `src/lib/lib-spec.ts:SubTransportAcp` + `src/lib/lib.ts:send` |
| `approval-mode` | T3 | ✅ | `src/lib/lib.ts:getApprovalMode/setApprovalMode` (config-driven) |
| `session-export` | T3 | ✅ | `src/tools/dsh-sessions.ts` (action=export) + `src/lib/session-store.ts:exportTo` |
| `discovery-tool-list` | opt | ✅ | `src/lib/lib.ts:listTools` |

## Coverage by sibling adapter

| Adapter | Tier 1 (4) | Tier 2 (2) | Tier 3 (6) | TOTAL (12) |
|---------|:----------:|:----------:|:----------:|:----------:|
| **dsh-cli-mcp** (this) | 4/4 | 2/2 | 6/6 | **12/12** |
| kimi-cli-mcp | 4/4 | 2/2 | 5/6 | 11/12 |
| qwen-cli-mcp | 4/4 | 2/2 | 4/6 | 10/12 |
| mcode-mcp | 4/4 | 2/2 | 2/6 | 8/12 |
| pi-cli-mcp | 4/4 | 1/2 | 1/6 | 6/12 |
| grok-cli-mcp | 4/4 | 1/2 | 1/6 | 6/12 |

## Out of v1 (deferred)

- `shell` — only qwen has it; not in scope for v1
- `observability-otel` — 0/5 adapters; requires collector; v2

## Cross-adapter lib (planned)

The `lib/` directory in this repo is the reference implementation of the
`lib v1` contract. For the next phase of the project, this code will be
extracted into a separate `cli-mcp-lib` npm package so all six adapters can
depend on it instead of duplicating the logic.

See `/workspace/mcp-knowledge/lib-docs/FINAL-REPORT.md` for the full design
rationale.
