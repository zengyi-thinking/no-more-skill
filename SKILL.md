---
name: no-more-skill
description: Behavior learning and safe execution skill for No More Skill (NMS). Use when the user asks to learn preferences from compressed conversations, inspect `.nms` behavior data, visualize skill/workflow frequency, export agent-readable user context, generate real-data reports, or run guarded night automation with dry-run/test/review gates.
---

# NMS Skill

## Purpose

Upgrade prompt engineering into behavior engineering plus a guarded execution system.

NMS records real user behavior into `.nms`, derives workflow/profile snapshots, exports compact Agent context, and generates auditable reports. Prefer real `.nms` data; never invent skill frequency or workflow history.

## Commands

- `npm run dev -- flow`
- `npm run dev -- report`
- `npm run dev -- auto`
- `npm run dev -- birthday`
- `npm run dev -- ingest --input <file>`
- `npm run dev:skill -- /nms-flow`

Slash routes:

- `/nms-flow`
- `/nms-report`
- `/nms-auto`
- `/nms-birthday`

Internal Agent steps are intentionally hidden from user-facing help. Agents should use `/nms-auto` for the complete guarded workflow. `/nms-birthday` writes a living memory capsule that future `/nms-auto` runs can inherit.

Runtime aliases:

- GSD/Gemini: `/nms:flow`, `/nms:report`, `/nms:auto`, `/nms:birthday`
- Codex: `$nms-flow`, `$nms-report`, `$nms-auto`, `$nms-birthday`

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
7. Rollback must be non-destructive; never reset the user's full working tree.
8. Reports and images must use real `.nms` data and record artifacts.

## Artifacts

- Compatibility store: `.nms/data.json`
- v3 store: `.nms/events`, `.nms/sessions`, `.nms/derived`, `.nms/artifacts`, `.nms/policies`, `.nms/domains`
- Agent context: internal `nms context`
- Night logs: `.nms/artifacts/night-runs`

## References

- `skills/nms-core/references/AGENT_PROTOCOL.md` for how Agents should call NMS.
- `skills/nms-core/references/DATA_MODEL.md` for `.nms` v3 storage rules.
- `skills/nms-core/references/SAFETY.md` for apply and rollback boundaries.
- `skills/nms-core/references/REPORTING.md` for report/image artifact rules.
- `skills/nms-core/references/DOMAIN_PACKS.md` for non-coding expansion.

## Promotion Notes

- Start with real session payloads and real task-file inputs.
- Show dry-run first, then explain why `--apply` is intentionally restricted.
