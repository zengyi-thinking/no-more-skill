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

## Agent/internal slash commands

- `/nms-brief`
- `/nms-suggest`
- `/nms-guard`
- `/nms-context`
- `/nms-night`
- `/nms-replay`
- `/nms-ingest`
- `/nms-data`
- `/nms-profile`
- `/nms-doctor`

## Runtime aliases

- GSD style: `/nms:flow`, `/nms:report`, `/nms:auto`
- Codex style: `$nms-flow`, `$nms-report`, `$nms-auto`
- Agent route mode: `nms route --cmd /nms-flow`

## Notes

- `--apply` is explicit and guarded.
- `/nms-auto` wraps `.nms` data, brief, suggest, guard, and dry-run gate for users.
- `/nms-night` is the internal execution engine; `--task-file` is required for production apply.
- `/nms-context` and `/nms-brief` are internal Agent entries before doing user-specific work.
- `/nms-guard` checks pending Git files by default; pass explicit files only for automation.
- Reports must use real `.nms` data; if samples are missing, say so instead of inventing.

## References

- `references/AGENT_PROTOCOL.md` - Agent calling contract.
- `references/DATA_MODEL.md` - `.nms` v3 storage and migration.
- `references/SAFETY.md` - apply, branch, path, secret, rollback rules.
- `references/REPORTING.md` - report, image, prompt, artifact rules.
- `references/DOMAIN_PACKS.md` - expansion beyond coding.
