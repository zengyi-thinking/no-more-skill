# NMS 3-Minute Demo

## 1) Learn behavior

```bash
cat > input.json <<'JSON'
{
  "compressed_text": "PRD分析 UI生成 代码生成",
  "conversation": "先 PRD分析，再 UI生成，最后 代码生成",
  "tool": "codex"
}
JSON

npm run dev -- ingest --input input.json
```

## 2) Observe workflow

```bash
npm run dev -- flow
npm run dev -- replay
```

## 3) Run safe night harness

```bash
npm run dev -- night --dry-run --time-budget 1
```

Expected behavior:

- Runs state machine through `GATE`
- Produces logs and no repository writes
- `--apply` requires explicit opt-in and git-safe environment
