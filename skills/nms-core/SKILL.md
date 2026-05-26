---
name: nms-core
description: Core No More Skill runtime for `.nms` behavior storage, workflow replay, agent context export, real-data reports, and guarded night automation. Use when an Agent needs to ingest compressed context, inspect user skill/workflow frequency, call `/nms-*` routes, generate reports from real local behavior data, or run safe dry-run/apply automation.
---

# nms-core

NMS core skill for behavior learning, workflow replay, explainable night runs, and visual reporting.

## Slash commands

- `/nms-flow`
- `/nms-data`
- `/nms-profile`
- `/nms-context`
- `/nms-brief`
- `/nms-suggest`
- `/nms-guard`
- `/nms-replay`
- `/nms-night`
- `/nms-doctor`
- `/nms-report`
- `/nms-ingest`

All classified slash commands above are zero-argument first. Advanced flags still work for automation, but the user-facing path should start from these direct routes.

## Runtime aliases

- GSD style: `/nms:flow`, `/nms:brief`, `/nms:guard`, `/nms:night`
- Codex style: `$nms-flow`, `$nms-brief`, `$nms-guard`, `$nms-night`
- Agent route mode: `nms route --cmd /nms-flow`

## Notes

- `--apply` is explicit and guarded.
- `/nms-night` auto-planning is dry-run only; `--task-file` is required for production apply.
- `/nms-context` and `/nms-brief` are the preferred Agent entries before doing user-specific work.
- `/nms-guard` checks pending Git files by default; pass explicit files only for automation.
- Reports must use real `.nms` data; if samples are missing, say so instead of inventing.

## References

- `references/AGENT_PROTOCOL.md` - Agent calling contract.
- `references/DATA_MODEL.md` - `.nms` v3 storage and migration.
- `references/SAFETY.md` - apply, branch, path, secret, rollback rules.
- `references/REPORTING.md` - report, image, prompt, artifact rules.
- `references/DOMAIN_PACKS.md` - expansion beyond coding.
