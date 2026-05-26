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

## Start In 30 Seconds

After installation, run:

```bash
/nms
```

It reads the current `.nms` data state and tells you the next action. With empty data, NMS says it is still learning instead of inventing a profile. Shortest path:

1. Feed one real compressed event: ask the Agent to call NMS ingest, or run `nms ingest --input input.json`
2. Inspect the behavior cockpit: `/nms-flow`
3. Let the Agent run a safe dry-run workflow: `/nms-auto`
4. Generate an inheritable memory asset: `/nms-birthday`

## What makes it different

1. It learns behavior traces, not only static prompts.
2. Safety-first defaults: dry-run, retry cap, write whitelist, branch guard.
3. It converges over time: main workflows become clearer and reusable.
4. It is explainable: `/nms-auto` prints the dry-run gate chain and why it passed or rolled back.
5. It is not limited to coding: domain packs let writing, research, learning, product, content, or your own domains use the same behavior model.

## User-Facing Commands

Most users only need four commands:

- `/nms-flow`: inspect recent workflows, skill frequency, user style, and data health.
- `/nms-report`: generate a visual HTML report from real `.nms` behavior data.
- `/nms-auto`: simulate the user's workflow from `.nms` and run the guarded dry-run gate.
- `/nms-birthday`: generate a living birthday memory capsule that future Agents can inherit.

`/nms-birthday` is not just a yearly summary. It writes `.nms/derived/birthday/latest.json`, and future `/nms-auto` runs inherit its North Star and next-year targets through Agent Context.

## Agent Workflow

Users no longer need to memorize internal commands. `/nms-auto` behaves like a cautious development Agent and automatically:

- reads `.nms` behavior memory and user style
- builds the preflight brief and selects a workflow
- checks write boundaries and pending Git files
- runs the dry-run Gate with pass/block reasons
- returns the next concrete action

## Domain Packs

NMS reads `.nms/domains/*.json` as real behavior domain packs. Built-ins include:

- `coding`: code analysis, UI generation, code generation, debugging, architecture design
- `writing`: topic analysis, reader analysis, outlining, drafting, title optimization, publishing review
- `research`: problem definition, source collection, cross-checking, source evaluation, synthesis
- `learning`: learning goals, material selection, practice, feedback, review
- `product`: requirements, user analysis, prototype design, copywriting, demos, launch
- `content`: scripts, storyboards, pages, images, publishing, content review

You can add your own pack such as `.nms/domains/fitness.json`. When compressed context contains those skills, `ingest` stores the detected domain and `flow --domain fitness` plus `report` use it in real stats.

## Local `.nms` Data Layer

NMS v0.4 writes real behavior data under `.nms/`:

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

If your host uses `/<skill>-<function>` style, normal users should call:

- `/nms-flow`
- `/nms-report`
- `/nms-auto`
- `/nms-birthday`

These commands call internal capabilities automatically. For example, `/nms-auto` transparently uses brief, suggest, guard, and the night gate.

GSD/Gemini style aliases:

- `/nms:flow`
- `/nms:report`
- `/nms:auto`
- `/nms:birthday`

Codex style aliases:

- `$nms-flow`
- `$nms-report`
- `$nms-auto`
- `$nms-birthday`

> Note: when testing `$nms-*` in local PowerShell, quote the command token: `npm run dev:skill -- '$nms-flow'`. In host command palettes, quoting is not required.

Local entry:

```bash
npm run dev:skill -- /nms-flow
npm run dev -- route --cmd nms-flow
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
npm run dev -- report
npm run dev -- auto
npm run dev -- birthday
```

## Output Experience

- `nms flow --visual` creates `.nms/flow-dashboard.html` with domain mix, skill frequency, main workflow path, and workflow edges.
- `nms report` generates a product-style HTML cockpit report from real `.nms` data by default.
- `nms auto` reads `.nms`, infers the workflow, checks write boundaries, and enters the dry-run Gate without applying changes.
- `nms birthday` writes `.nms/derived/birthday/latest.json` plus a birthday HTML page; future `nms context` and `/nms-auto` inherit `birthday_memory`.
- Internal Agent capabilities still exist, but `/nms-auto` owns the user-facing workflow so users do not need to memorize them.

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
