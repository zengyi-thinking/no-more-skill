# NMS Agent Protocol

Use this reference when an Agent needs to adapt to the user's real behavior before executing a task.

## Preferred Entry

Run:

```bash
nms brief
nms context
```

Use the output to determine:

- Communication style.
- Reusable workflows.
- Things to avoid.
- Safety policy.
- Data confidence.

If `data_quality.sample_count` is low, do not infer strong preferences. Say that the profile is still learning.

## Normal Workflow

1. Call `nms data` if you need to know whether `.nms` has enough evidence.
2. Call `nms brief` before user-specific work.
3. Call `nms suggest` when you need a workflow recommendation.
4. Read `user_style`, `relevant_workflows`, and `safety_policy` from `nms context` when machine-readable context is needed.
5. Before writing files, call `nms guard`; it checks pending Git files by default. Treat `ok=false` as a hard stop.
6. Execute the task within policy and run validation when code or files are changed.
7. If the interaction should become training data, ask the host to call `nms ingest` with a real compressed event.

## User-Facing Slash Routes

- `/nms-flow`
- `/nms-report`
- `/nms-auto`

## Internal Slash Routes

- `/nms-data`
- `/nms-profile`
- `/nms-context`
- `/nms-brief`
- `/nms-suggest`
- `/nms-guard`
- `/nms-replay`
- `/nms-night`
- `/nms-doctor`
- `/nms-ingest`

## Constraints

- Do not read raw `.nms` internals unless the CLI lacks the needed output.
- Do not invent skill frequency, workflows, or profile traits.
- Do not expose raw conversation text by default.
- Treat `safety_policy.requires_explicit_apply=true` as a hard boundary.
- Treat default `nms auto` and `nms night` as dry-run-only. Apply mode requires an explicit reviewed task file.
