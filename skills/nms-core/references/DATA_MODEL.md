# NMS Data Model

NMS v0.3 keeps `.nms/data.json` for compatibility and writes v3 data beside it.

## v3 Layout

```text
.nms/
├── config.json
├── events/YYYY-MM.jsonl
├── sessions/YYYY/MM/sess_xxx.json
├── derived/
│   ├── stats.json
│   ├── workflows.json
│   ├── profile.json
│   ├── quality.json
│   └── agent-context.json
├── artifacts/
│   ├── artifacts.json
│   ├── reports/
│   ├── images/
│   ├── prompts/
│   └── night-runs/
├── policies/
│   ├── safety.json
│   └── redaction.json
├── domains/*.json
└── backups/
```

## Source Of Truth

- Events and session files are factual history.
- Derived files are rebuildable snapshots.
- `data.json` is compatibility state for old commands and tests.
- Artifacts are generated outputs with metadata.

## Migration

When old `data.json` has `schema_version < 3`:

1. Copy it to `.nms/backups/data-v<version>-<timestamp>.json`.
2. Redact secrets.
3. Set compatibility schema to `3`.
4. Write v3 session files.
5. Write derived snapshots.

## Privacy

NMS should redact:

- Bearer tokens.
- `sk-...` style keys.
- `api_key=...`, `token=...`, `secret=...`, `password=...`.

Agents should prefer evidence refs over raw conversation text.
