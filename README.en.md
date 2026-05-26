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
5. It is not limited to coding: domain packs let writing, research, learning, product, content, or your own domains use the same behavior model.

## Core Commands

- `nms ingest`: ingest compressed context and extract skills/workflows
- `nms flow`: behavior cockpit (`--format human|json`)
- `nms context`: export agent-readable user behavior context
- `nms replay`: replay the most common workflow
- `nms night`: guarded night loop (default dry-run)
- `nms doctor`: read-only diagnostics
- `nms report`: real-data report generation in Markdown/HTML/JSON (optional image rendering)

## Domain Packs

NMS reads `.nms/domains/*.json` as real behavior domain packs. Built-ins include:

- `coding`: code analysis, UI generation, code generation, debugging, architecture design
- `writing`: topic analysis, reader analysis, outlining, drafting, title optimization, publishing review
- `research`: problem definition, source collection, cross-checking, source evaluation, synthesis
- `learning`: learning goals, material selection, practice, feedback, review
- `product`: requirements, user analysis, prototype design, copywriting, demos, launch
- `content`: scripts, storyboards, pages, images, publishing, review

You can add your own pack such as `.nms/domains/fitness.json`. When compressed context contains those skills, `ingest` stores the detected domain and `flow --domain fitness` plus `report` use it in real stats.

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
npm run dev -- flow --visual
npm run dev -- replay
npm run dev -- night --dry-run --explain --task-file task.json --time-budget 1
npm run dev -- doctor
npm run dev -- report --format html --real-only
```

## Output Experience

- `nms flow --visual` creates `.nms/flow-dashboard.html` with domain mix, skill frequency, main workflow path, and workflow edges.
- `nms context --format json` includes relevant domains, workflows, avoid-list, and safety policy for other Agents.
- `nms report --format html --real-only` generates a product-style cockpit report with domain distribution, skill usage, workflow graph, user style, and next commands.

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
