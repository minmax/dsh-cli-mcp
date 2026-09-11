# Changelog

## v1.0.0 — feat/full-v1 (PR #2)

**Что внутри:**
- 7 MCP tools: `dsh`, `dsh_reply`, `dsh_models`, `dsh_sessions`, `dsh_running`, `dsh_send`, `dsh_history`
- `src/lib/` — 9 модулей (binary, config, errors, lib-spec, lib, logger, process-runner, semaphore, session-store)
- 62/62 tests passing (5 файлов: cancellation, dsh, fake-dsh, integration, lib)
- `test/fake-dsh.ts` — TypeScript-класс 427 LOC с state, validation, call records, `setFailNext`, `setSleep`
- `docs/FEATURES.md`, `docs/REVIEW.md`, `docs/LIB-DESIGN.md`, `docs/REPORTS.md`

**Commits:**
- `e3bb353` feat: full v1.0.0 with lib + 7 tools
- `24d65be` fix: propagate --approval-mode to CLI; replace reflection hack with lib.listActiveRuns()
- `a625769` feat: 4 missing test cases + reports in repo
- `12f0437` test: rewrite fake-dsh from shell to TypeScript with smart validation
- `e27b18c` chore: ignore dist-test/ (built fake-dsh binary)

## v0.1.0 — initial scaffold (PR #1, closed)

Минимальный MCP-сервер с одним tool `dsh`. Cancelled per user request
("let me implement everything first, then come with PR").

## См. также

- `docs/PROCESS.md` — как мы к этому пришли
- `docs/REVIEW.md` — self-audit (12/12 lib v1 coverage)
