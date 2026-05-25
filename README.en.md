# no-more-skill (NMS)

Default language: Chinese (`README.md`)

![NMS Skill Hero](./images/nms-skill-hero.png)

NMS is not just another prompt utility.  
It is a behavior-engineering system that learns how you work and runs a guarded execution loop:
- Learn user behavior during daytime (`skills/workflow/style`)
- Execute safely at night with a strict state machine
- Keep outputs auditable and actionable
- Export agent-readable context from local `.nms` behavior data

In one line: **from prompt engineering to behavior engineering + execution system.**

## What makes it different

1. It learns behavior traces, not only static prompts.
2. Safety-first defaults: dry-run, retry cap, write whitelist, branch guard.
3. It converges over time: main workflows become clearer and reusable.
4. It is explainable: `nms night --explain` shows why gate passed or rolled back.

## Core Commands

- `nms ingest`: ingest compressed context and extract skills/workflows
- `nms flow`: behavior cockpit (`--format human|json`)
- `nms context`: export agent-readable user behavior context
- `nms replay`: replay the most common workflow
- `nms night`: guarded night loop (default dry-run)
- `nms doctor`: read-only diagnostics
- `nms report`: real-data report generation in Markdown/HTML/JSON (optional image rendering)

## Local `.nms` Data Layer

NMS v0.3 writes real behavior data under `.nms/`:

- `.nms/events/`: append-only event logs
- `.nms/sessions/`: real behavior sessions split by year/month
- `.nms/derived/`: rebuildable stats, profile, workflow, and agent-context snapshots
- `.nms/artifacts/`: reports, prompts, images, and night-run audit files
- `.nms/policies/`: safety and redaction policies
- `.nms/domains/`: behavior packs for coding, writing, research, learning, product, and content work

`.nms/data.json` remains as a compatibility store. Older data is migrated to the v3 layout and backed up under `.nms/backups/`.

Do not commit a real `.nms` folder to a public repository unless you have reviewed the contents.

## Install Matrix

| Method | Best for | Command |
|---|---|---|
| `npx skills` | Fast cross-agent install | `npx skills add zengyi-thinking/no-more-skill` |
| Claude plugin marketplace | Claude Code users | `/plugin marketplace add zengyi-thinking/no-more-skill` |
| Local dev install | debugging and extension | `npm install && npm run build && npm link` |
| Pinned zip artifact | CI/reproducible setup | `npm run release:pack` (includes marketplace + skill files) |

## Slash Skill Routing

If your host uses `/<skill>-<function>` style, use:

- `/nms-ingest --input input.json`
- `/nms-flow --format human`
- `/nms-flow --visual`
- `/nms-context --task "generate weekly project report" --format json`
- `/nms-replay`
- `/nms-night --dry-run --explain --task-file task.json`
- `/nms-doctor`
- `/nms-report --format html --real-only`
- `/nms-report --image`

GSD/Gemini style aliases:

- `/nms:flow`
- `/nms:night`
- `/nms:report`

Codex style aliases:

- `$nms-flow`
- `$nms-night --dry-run --task-file task.json`
- `$nms-report --image`

> Note: when testing `$nms-*` in local PowerShell, quote the command token: `npm run dev:skill -- '$nms-flow' --format human`. In host command palettes, quoting is not required.

Local entry:

```bash
npm run dev:skill -- /nms-flow --format json
npm run dev -- route --cmd nms-flow --args-json "{\"format\":\"json\"}"
```

After marketplace registration:

```bash
/plugin install nms-skills@no-more-skill
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
npm run dev -- context --task "generate weekly project report" --format json
npm run dev -- replay
npm run dev -- night --dry-run --explain --task-file task.json --time-budget 1
npm run dev -- doctor
npm run dev -- report --format html --real-only
```

## Safety Boundaries

- `--apply` must be explicit
- TEST/REVIEW cannot be skipped
- `max_retry = 3`
- write scope guard (path + file type)
- protected behavior on main branch
- non-destructive rollback; NMS must not reset the whole working tree
- reports and images use real `.nms` data and record artifacts

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
