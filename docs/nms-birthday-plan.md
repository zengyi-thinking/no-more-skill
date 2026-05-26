# NMS Birthday Plan

## Product Definition

`/nms-birthday` is not a one-off birthday summary. It is a yearly memory checkpoint that turns real `.nms` behavior data into an evolvable Agent asset.

Core metaphor: the system may wake up every day, but it must not forget the user's North Star.

The command should generate:

- A living memory capsule for Agents.
- A shareable birthday / yearly evolution HTML page.
- A human-readable Markdown story.
- An optional poster image when image relay is configured.

## User-Facing Behavior

Primary command:

- `/nms-birthday`

Zero-argument default behavior:

1. Read real `.nms` sessions and derived stats.
2. Compare the latest 365 days against the previous 365 days.
3. Generate a birthday memory capsule.
4. Write the capsule to `.nms/derived/birthday/latest.json`.
5. Generate `.nms/artifacts/birthday/latest/birthday.html`.
6. Register artifacts in `.nms/artifacts/artifacts.json`.
7. Make future `/nms-auto` inherit `birthday_memory` through `nms context`.

Optional automation flags can exist for Agents, but must not be required for normal users.

## Storage Contract

Latest Agent asset:

```text
.nms/derived/birthday/latest.json
```

History:

```text
.nms/derived/birthday/history/<timestamp>.json
```

Human artifacts:

```text
.nms/artifacts/birthday/latest/birthday.html
.nms/artifacts/birthday/latest/birthday.md
.nms/artifacts/birthday/latest/assets/birthday-poster.png
```

The capsule must be real-data only. If sample count is low, the output must say so and avoid inventing skills, workflows, or personality claims.

## Capsule Schema

```json
{
  "schema_version": 1,
  "generated_at": "",
  "project_id": "",
  "period_days": 365,
  "sample_count": 0,
  "previous_sample_count": 0,
  "north_star": "",
  "retained_commitments": [],
  "stable_workflows": [],
  "emerging_skills": [],
  "changed_habits": [],
  "growth_vectors": [
    {
      "name": "",
      "signal": "",
      "evidence": []
    }
  ],
  "risks_to_watch": [],
  "next_year_targets": [],
  "agent_instructions": [],
  "artifacts": {
    "capsule_ref": "",
    "html_report_ref": "",
    "markdown_ref": "",
    "poster_ref": ""
  }
}
```

## Agent Inheritance

`JsonStorage.buildAgentContext()` should read `.nms/derived/birthday/latest.json` when it exists and expose:

```json
{
  "birthday_memory": {
    "latest_capsule_ref": "",
    "generated_at": "",
    "north_star": "",
    "retained_commitments": [],
    "next_year_targets": [],
    "risks_to_watch": []
  }
}
```

`/nms-auto` should include this memory in its hidden Agent workflow. This makes the birthday feature operational: it changes future Agent behavior without exposing low-level commands to the user.

## Safety Rules

- Birthday narrative must never override safety policy.
- No fake skill frequency, workflow history, or personality claims.
- Low sample count must be explicit.
- `north_star` is guidance, not permission to write files.
- `/nms-auto` still defaults to dry-run and must preserve Gate behavior.

## Expansion Areas

The same birthday asset can apply beyond coding:

- Writing: yearly voice and publishing evolution.
- Learning: study loops, weak spots, and next-year practice plan.
- Product: product sense, launch habits, demo quality.
- Content: script, visual, publishing, and review loops.
- Life systems: routines, communication style, and decision habits.

## Acceptance Criteria

- `/nms-birthday` works with zero arguments.
- It creates `latest.json`, history JSON, HTML, and Markdown outputs.
- Empty data does not crash and does not invent behavior.
- `nms context --format json` includes `birthday_memory` after running birthday.
- `/nms-auto` includes birthday North Star when memory exists.
- User-facing help lists `/nms-birthday`; internal commands remain hidden.
- Release validation and smoke install pass.
