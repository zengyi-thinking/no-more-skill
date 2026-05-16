# nms-core

NMS core skill for behavior learning, workflow replay, explainable night runs, and visual reporting.

## Slash commands

- `/nms-ingest --input <file>`
- `/nms-flow [--format human|json] [--visual]`
- `/nms-replay`
- `/nms-night --dry-run --task-file <task.json> [--explain]`
- `/nms-night --apply --task-file <task.json>`
- `/nms-doctor`
- `/nms-report [--image]`

## Runtime aliases

- GSD style: `/nms:flow`, `/nms:night`
- Codex style: `$nms-flow`, `$nms-night`

## Notes

- `--apply` is explicit and guarded.
- `--task-file` is required for production night runs.
