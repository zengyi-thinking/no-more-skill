# NMS Reporting

Reports must be based on real `.nms` data.

## Commands

```bash
nms report --period 1d --format html --real-only
nms report --period 7d --format md
nms report --period 30d --format json
nms report --period 7d --format html --template video --real-only
nms report --period 7d --format html --template portfolio --real-only
nms report --period 7d --format html --image
```

## Templates

- `daily`: short operating brief for recent work.
- `weekly`: default behavior cockpit for recurring review.
- `video`: presentation script with opening, evidence path, demo flow, and closing line.
- `portfolio`: evidence board for showing capabilities, workflow, artifacts, and safety boundaries.

## Required Sections

- Sample count and data period.
- Domain mix.
- Skill frequency.
- Workflow path ranking.
- Workflow transition edges.
- Behavior score and workflow confidence.
- Current user style.
- Risks and stale skills.
- Actionable suggestions with `why` and `next_command`.

## Image Rule

Before calling any image backend:

1. Generate the final prompt from real `.nms` metrics.
2. Save it to `.nms/artifacts/prompts/`.
3. Call the image service.
4. Save the image to `.nms/artifacts/images/`.
5. Register both prompt and image in `.nms/artifacts/artifacts.json`.

If real samples are insufficient, the report and prompt must say so. Do not fill missing metrics with demo values.

## HTML Cockpit Requirements

The HTML report should feel like a product cockpit, not a plain table:

- Hero summary with period and sample count.
- Metric cards for behavior score, confidence, and stale risk.
- Domain distribution bars.
- Skill frequency bars.
- Main workflow path.
- Workflow edge chips.
- Source note that data came from `.nms/sessions` and `.nms/derived`.
