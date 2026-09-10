# Reports — design rationale & audits

This folder holds the cross-adapter design and the dsh-cli-mcp self-audit.

| File | What |
|------|------|
| [FEATURES.md](FEATURES.md) | lib v1 features → implementation map for this repo |
| [REVIEW.md](REVIEW.md) | self-audit: every claimed feature verified against the code |
| [LIB-DESIGN.md](LIB-DESIGN.md) | TL;DR of the cross-adapter lib design (11 features, 5 siblings) |

For the full design history, see
[/workspace/mcp-knowledge/lib-docs/](../) in the source workspace
(not shipped in the npm package):

- 15 feature-by-feature docs (one per lib feature, with reference impl from
  the 5 sibling adapters)
- `dedup-report.md` — what got merged, renamed, or deferred
- `reverify-{mcode,qwen,grok,kimi,pi}.md` — per-adapter status
- `final-matrix.md` — canonical 5×15 feature matrix
- `FINAL-REPORT.md` — executive summary
- `dsh-cli-mcp-review.md` — the same audit as REVIEW.md, kept in sync
