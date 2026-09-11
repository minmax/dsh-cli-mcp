# dsh-cli-mcp — process notes

## Что это

`dsh-cli-mcp` (DeepSeek Harness CLI MCP wrapper) — первый из 5 MCP-серверов
против CLI-агентов, потом переросший в общий lib v1 + отдельные обёртки
(`mcode-mcp`, `qwen-cli-mcp`, `grok-cli-mcp`, `kimi-cli-mcp`, `pi-cli-mcp`).

## Процесс

### Цикл 1: первая реализация (PR #2 → open)

1. **Скаффолд v0.1.0** — минимальный MCP-сервер с одним tool `dsh` (PR #1, потом closed)
2. **v1.0.0** — полная реализация:
   - `src/lib/` — 9 модулей: binary, config, errors, lib-spec, lib, logger, process-runner, semaphore, session-store
   - 7 tools: dsh, dsh_reply, dsh_models, dsh_sessions, dsh_running, dsh_send, dsh_history
   - 62/62 tests (5 файлов)
3. **PR review fixes:**
   - fix: propagate `--approval-mode` в CLI (заменил reflection hack на `lib.listActiveRuns()`)
   - feat: 4 недостающих test cases + reports в репо
   - test: rewrite fake-dsh из shell в TypeScript с умной валидацией (427 LOC)
   - chore: ignore dist-test/

### Уроки

- **Smart fake обязателен.** Dumb echo-fake не ловит error paths, abort,
  concurrent prompts. После первого раза — TypeScript-класс с state,
  call records, `setFailNext`, `setSleep`. Этот паттерн потом скопирован
  в `kagero-mcp` (`test/fake-cli.ts`, 430 LOC).
- **lib вытаскивай сразу.** Если думаешь что будет 2+ CLI-агента с
  похожим поведением — сначала спроектируй lib contract. У нас это
  заняло 4 этапа:
  1. 15 фич-документов на каждый CLI
  2. dedup-report (8979 B)
  3. 5 reverify-*.md
  4. final-matrix (12207 B) + FINAL-REPORT
- **Strict TS + exactOptionalPropertyTypes** ловит half-typed APIs.
  Используй `if (x) obj.foo = x;` pattern, не `obj.foo = x ?? default`.

## Документы в репо

- `README.md` — quickstart + 7 tools + config
- `docs/FEATURES.md` — какие фичи покрыты и где
- `docs/REVIEW.md` — self-audit v1.0.0 (12/12 lib v1 coverage)
- `docs/LIB-DESIGN.md` — архитектура lib
- `docs/REPORTS.md` — отчёты по процессам
- `docs/CHANGELOG.md` — история версий
- `docs/PROCESS.md` — этот файл
