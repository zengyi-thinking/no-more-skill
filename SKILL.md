# NMS Skill (Codex)

## Purpose

Upgrade prompt engineering into behavior engineering plus an execution harness.

## Trigger Cases

- User asks to learn behavior from compressed conversations
- User asks for workflow visualization or replay
- User asks to run safe night automation with strong test/review gates

## Commands

- `npm run dev -- ingest --input <file>`
- `npm run dev -- flow`
- `npm run dev -- replay`
- `npm run dev -- night --dry-run --task-file <task.json>`
- `npm run dev -- night --apply --task-file <task.json>`
- `npm run dev:skill -- /nms-flow --format json`

Slash routes:

- `/nms-ingest`
- `/nms-flow`
- `/nms-replay`
- `/nms-night`
- `/nms-doctor`
- `/nms-report`

Runtime aliases:

- GSD/Gemini: `/nms:flow`, `/nms:night`, `/nms:report`
- Codex: `$nms-flow`, `$nms-night`, `$nms-report`

Install:

- `npx skills add zengyi-thinking/no-more-skill`

## Input / Output Contract

Hook input:

```json
{ "compressed_text": "", "conversation": "", "tool": "claude|codex" }
```

Hook output:

```json
{ "skills_used": [], "workflow": [], "edges": [], "user_style": "" }
```

## Safety Rules (Hard Constraints)

1. No skipping test phase.
2. No skipping review phase.
3. Gate requires `test.passed` and `review.spec_approved && review.code_approved`.
4. Max retry = 3.
5. Apply mode is explicit; default is dry-run.
6. Write guard blocks out-of-scope paths.

## Artifacts

- Storage: `.nms/data.json`
- Session model: `sessions + stats + user_profile`
- Night logs: JSON report from `nms night`

## Promotion Notes

- Start with real session payloads and real task-file inputs.
- Show dry-run first, then explain why `--apply` is intentionally restricted.
