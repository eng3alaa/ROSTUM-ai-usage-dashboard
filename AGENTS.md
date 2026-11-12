# ROSTUM — notes for coding agents

Project conventions, the resume point and the live plan are in `docs/superpowers/` (start with the newest file under `docs/superpowers/plans/`).

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues (`eng3alaa/ROSTUM-ai-usage-dashboard`, via the `gh` CLI). The repo is public: security findings go through private vulnerability reporting (see `SECURITY.md`), never into an issue. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root (both created lazily, when terms or decisions are actually resolved). See `docs/agents/domain.md`.
