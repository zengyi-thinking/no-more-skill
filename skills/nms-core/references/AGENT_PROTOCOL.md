# NMS Agent Protocol

Use this reference when an Agent needs to adapt to the user's real behavior before executing a task.

## Preferred Entry

Run:

```bash
nms context --task "<task summary>" --format json
```

Use the output to determine:

- Communication style.
- Reusable workflows.
- Things to avoid.
- Safety policy.
- Data confidence.

If `data_quality.sample_count` is low, do not infer strong preferences. Say that the profile is still learning.

## Normal Workflow

1. Call `nms context --task "<task>" --format json`.
2. Read `user_style`, `relevant_workflows`, and `safety_policy`.
3. Tell the user what real data was used if the task is user-specific.
4. Execute the task within the policy.
5. Run validation when code or files are changed.
6. If the interaction should become training data, ask the host to call `nms ingest` with a real compressed event.

## Slash Routes

- `/nms-context --task <task> --format json`
- `/nms-flow --format json`
- `/nms-report --format html --real-only`
- `/nms-night --dry-run --explain --task-file <task.json>`

## Constraints

- Do not read raw `.nms` internals unless the CLI lacks the needed output.
- Do not invent skill frequency, workflows, or profile traits.
- Do not expose raw conversation text by default.
- Treat `safety_policy.requires_explicit_apply=true` as a hard boundary.
