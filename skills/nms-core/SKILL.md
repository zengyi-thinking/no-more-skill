---
name: nms-core
description: Core No More Skill runtime for `.nms` behavior storage, workflow replay, agent context export, real-data reports, and guarded night automation. Use when an Agent needs to ingest compressed context, inspect user skill/workflow frequency, call `/nms-*` routes, generate reports from real local behavior data, or run safe dry-run/apply automation.
---

# nms-core

NMS core skill for behavior learning, workflow replay, explainable night runs, and visual reporting.

## Slash commands

- `/nms action=flow|ingest|replay|night|doctor|report` (统一入口)
- `/nms-ingest --input <file>`
- `/nms-flow [--format human|json] [--visual]`
- `/nms-context --task <task> [--format human|json]`
- `/nms-replay`
- `/nms-night --dry-run --task-file <task.json> [--explain]`
- `/nms-night --apply --task-file <task.json>`
- `/nms-doctor`
- `/nms-report [--format md|html|json] [--image] [--real-only]`

## Runtime aliases

- GSD style: `/nms:flow`, `/nms:night`
- Codex style: `$nms-flow`, `$nms-night`
- Agent route mode: `nms route --cmd /nms-flow --args-json "{\"format\":\"json\"}"`

## Notes

- `--apply` is explicit and guarded.
- `--task-file` is required for production night runs.
- `nms context --format json` is the preferred Agent entry before doing user-specific work.
- Reports must use real `.nms` data; if samples are missing, say so instead of inventing.

## References

- `references/AGENT_PROTOCOL.md` - Agent calling contract.
- `references/DATA_MODEL.md` - `.nms` v3 storage and migration.
- `references/SAFETY.md` - apply, branch, path, secret, rollback rules.
- `references/REPORTING.md` - report, image, prompt, artifact rules.
- `references/DOMAIN_PACKS.md` - expansion beyond coding.
