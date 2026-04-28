# no-more-skill (NMS)

NMS is a behavior-engineering CLI that learns from compressed context and runs a constrained night harness for safe task automation.

## Features

- `nms ingest`: learn sessions from local JSON/stdin payloads
- `nms flow`: show recent workflow, top skills, idle skills, next suggestion
- `nms replay`: replay the most common workflow
- `nms night`: run strict state machine (`PLAN -> EXECUTE -> TEST -> REVIEW -> GATE`)
- Safe by default: dry-run mode, retry cap, write-scope guard

## Quick Start

```bash
npm install
npm run build
node dist/cli.js flow
```

Use a payload file:

```json
{
  "compressed_text": "PRD分析 UI生成 代码生成",
  "conversation": "先 PRD分析, 再 UI生成, 最后 代码生成",
  "tool": "codex"
}
```

```bash
node dist/cli.js ingest --input input.json
node dist/cli.js flow
node dist/cli.js replay
node dist/cli.js night --dry-run --time-budget 1
```

## Safety Boundaries

- `--apply` is explicit opt-in only
- apply mode blocked outside git repo
- write scope limited to `sandbox/` or `feature/`, plus explicit whitelist
- only UI/new/test file patterns are allowed
- max retry is fixed at `3`

## Structure

- `src/hook/*`: behavior extraction pipeline
- `src/harness/*`: night state machine and gate
- `src/commands.ts`: CLI command implementation
- `tests/nms.test.ts`: MVP test coverage
- `SKILL.md`: Codex skill package guide
