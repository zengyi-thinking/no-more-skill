# NMS Agent Protocol

Use this reference when an Agent needs to adapt to the user's real behavior before executing a task.

## Preferred Entry

Run:

```bash
nms brief --task "<task summary>" --profile strict
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

1. Call `nms data status --format json` if you need to know whether `.nms` has enough evidence.
2. Call `nms brief --task "<task>" --profile strict` before user-specific work.
3. Call `nms suggest --task "<task>" --format json` when you need a workflow recommendation.
4. Read `user_style`, `relevant_workflows`, and `safety_policy` from `nms context --task "<task>" --format json` when machine-readable context is needed.
5. Before writing files, call `nms guard --files <file1,file2> --format json`; treat `ok=false` as a hard stop.
6. Execute the task within policy and run validation when code or files are changed.
7. If the interaction should become training data, ask the host to call `nms ingest` with a real compressed event.

## Slash Routes

- `/nms-context --task <task> --format json`
- `/nms-brief --task <task> --profile strict`
- `/nms-suggest --task <task> --format json`
- `/nms-guard --files <file,file> --format json`
- `/nms-data status --format json`
- `/nms-profile --review --format json`
- `/nms-flow --format json`
- `/nms-report --format html --template video --real-only`
- `/nms-night --dry-run --explain --task <task>`
- `/nms-night --dry-run --explain --task-file <task.json>`
- `/nms-night --resume <id>`

## Constraints

- Do not read raw `.nms` internals unless the CLI lacks the needed output.
- Do not invent skill frequency, workflows, or profile traits.
- Do not expose raw conversation text by default.
- Treat `safety_policy.requires_explicit_apply=true` as a hard boundary.
- Treat `nms night --task` as dry-run-only. Apply mode requires an explicit reviewed task file.
