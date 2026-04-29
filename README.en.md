# no-more-skill (NMS)

Default language: Chinese (`README.md`)

NMS is not just another prompt utility.  
It is a behavior-engineering system that learns how you work and runs a guarded execution loop:
- Learn user behavior during daytime (`skills/workflow/style`)
- Execute safely at night with a strict state machine
- Keep outputs auditable and actionable

In one line: **from prompt engineering to behavior engineering + execution system.**

## What makes it different

1. It learns behavior traces, not only static prompts.
2. Safety-first defaults: dry-run, retry cap, write whitelist, branch guard.
3. It converges over time: main workflows become clearer and reusable.
4. It is explainable: `nms night --explain` shows why gate passed or rolled back.

## Core Commands

- `nms ingest`: ingest compressed context and extract skills/workflows
- `nms flow`: behavior cockpit (`--format human|json`)
- `nms replay`: replay the most common workflow
- `nms night`: guarded night loop (default dry-run)
- `nms doctor`: read-only diagnostics
- `nms report`: production report generation (optional image rendering)

## Slash Skill Routing

If your host uses `/<skill>-<function>` style, use:

- `/nms-ingest --input input.json`
- `/nms-flow --format human`
- `/nms-flow --visual`
- `/nms-replay`
- `/nms-night --dry-run --explain --task-file task.json`
- `/nms-doctor`
- `/nms-report --image`

Local entry:

```bash
npm run dev:skill -- /nms-flow --format json
```

## Quick Start

```bash
npm install
npm run build
```

Create `input.json`:

```json
{
  "compressed_text": "PRD分析 UI生成 代码生成",
  "conversation": "先 PRD分析, 再 UI生成, 最后 代码生成",
  "tool": "codex"
}
```

Run:

```bash
npm run dev -- ingest --input input.json
npm run dev -- flow
npm run dev -- flow --format json
npm run dev -- replay
npm run dev -- night --dry-run --explain --task-file task.json --time-budget 1
npm run dev -- doctor
npm run dev -- report
```

## Safety Boundaries

- `--apply` must be explicit
- TEST/REVIEW cannot be skipped
- `max_retry = 3`
- write scope guard (path + file type)
- protected behavior on main branch

`task.json` example:

```json
{
  "task": "run a real night execution plan",
  "files": ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
  "constraints": ["UI/new/test scope only"],
  "test_plan": ["npm test"]
}
```
Image relay env vars:
```bash
NMS_IMAGE_BASE_URL="https://api.apimart.ai/v1/images/generations"
NMS_IMAGE_API_KEY="<token>"
NMS_IMAGE_MODEL="gpt-image-2"
```
