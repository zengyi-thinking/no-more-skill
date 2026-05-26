---
name: nms-core
description: Core No More Skill runtime for `.nms` behavior storage, workflow replay, agent context export, real-data reports, and guarded night automation. Use when an Agent needs to ingest compressed context, inspect user skill/workflow frequency, call `/nms-*` routes, generate reports from real local behavior data, or run safe dry-run/apply automation.
---

# nms-core

NMS core skill for behavior learning, workflow replay, explainable night runs, and visual reporting.

## User-facing slash commands

- `/nms-flow`
- `/nms-report`
- `/nms-auto`

These are the only commands that should be promoted to users. They are zero-argument first.

## Hidden Agent workflow

Do not promote low-level routes to users. `/nms-auto` is the public workflow entry and internally reads behavior context, builds a brief, selects a workflow, checks write scope, and runs the dry-run Gate.

## Runtime aliases

- GSD style: `/nms:flow`, `/nms:report`, `/nms:auto`
- Codex style: `$nms-flow`, `$nms-report`, `$nms-auto`
- Agent route mode: `nms route --cmd /nms-flow`

## Notes

- `--apply` is explicit and guarded.
- `/nms-auto` wraps `.nms` data, user brief, workflow suggestion, write guard, and dry-run gate without exposing low-level commands to users.
- The internal execution engine still requires an explicit reviewed task file for production apply.
- The write guard checks pending Git files by default; pass explicit files only for automation.
- Reports must use real `.nms` data; if samples are missing, say so instead of inventing.

## References

- `references/AGENT_PROTOCOL.md` - Agent calling contract.
- `references/DATA_MODEL.md` - `.nms` v3 storage and migration.
- `references/SAFETY.md` - apply, branch, path, secret, rollback rules.
- `references/REPORTING.md` - report, image, prompt, artifact rules.
- `references/DOMAIN_PACKS.md` - expansion beyond coding.
