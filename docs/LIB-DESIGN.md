# lib v1 design — TL;DR

> Cross-adapter contract that `dsh-cli-mcp` is built on, summarized.
> Full design doc lives in `/workspace/mcp-knowledge/lib-docs/`.

## 11 lib v1 features

| Feature | Tier | Implemented here |
|---------|------|-----------------|
| `transport-stdio` | T1 | ✅ |
| `session-list` | T1 | ✅ |
| `session-resume` | T1 | ✅ |
| `discovery-model-list` | T1 | ✅ |
| `cancellation` | T2 | ✅ |
| `observability-session-replay` | T2 | ✅ |
| `session-kill` | T3 | ✅ |
| `mid-run-abort` | T3 | ✅ |
| `mid-run-steer` | T3 | ✅ |
| `sub-transport-acp` | T3 | ✅ (interface; wire-protocol is CLI's job) |
| `approval-mode` | T3 | ✅ |
| `session-export` | T3 | ✅ |
| `discovery-tool-list` | opt | ✅ |

## Adapter coverage

| Adapter | T1 | T2 | T3 | TOTAL |
|---------|:--:|:--:|:--:|:-----:|
| **dsh-cli-mcp** | 4/4 | 2/2 | 6/6 | **12/12** ⭐ |
| kimi-cli-mcp | 4/4 | 2/2 | 5/6 | 11/12 |
| qwen-cli-mcp | 4/4 | 2/2 | 4/6 | 10/12 |
| mcode-mcp | 4/4 | 2/2 | 2/6 | 8/12 |
| pi-cli-mcp | 4/4 | 1/2 | 1/6 | 6/12 |
| grok-cli-mcp | 4/4 | 1/2 | 1/6 | 6/12 |

**dsh-cli-mcp is the only adapter at 12/12.** It is the reference implementation
for the other five to refactor against.

## Out of v1 (deferred)

- `shell` — only qwen has it; security overhead; v2
- `observability-otel` — 0/5 adapters; v2

## Open questions (5)

1. **approval-mode** — keep 4 universal values (yolo / default / auto / plan)
   or preserve qwen's 8?
2. **discovery-tool-list** — keep as helper or remove entirely?
3. **mid-run-steer** — uniform format across adapters, or per-CLI?
4. **session-cwd-tracking** (qwen) — add to `SessionStore`?
5. **session-lock** (qwen) — add `withSessionLock(sessionId, fn)`?

## Cross-references

- **Full design** — see [FINAL-REPORT](https://github.com/minmax) (in
  `/workspace/mcp-knowledge/lib-docs/FINAL-REPORT.md`)
- **15 feature docs** — in
  `/workspace/mcp-knowledge/lib-docs/{transport-stdio,session-list, ...}.md`
- **Dedup analysis** — `dedup-report.md` (rationale for what got merged /
  renamed / deferred)
- **Re-verify per CLI** — `reverify-{mcode,qwen,grok,kimi,pi}.md` (status of
  each existing adapter against the lib contract)
- **Final matrix** — `final-matrix.md` (canonical 5×15 matrix)
- **dsh-cli-mcp self-review** — [REVIEW.md](REVIEW.md) (audit of this
  implementation against the spec)
