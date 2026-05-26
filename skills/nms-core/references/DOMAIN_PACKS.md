# NMS Domain Packs

NMS should learn behavior beyond programming.

## Domain Pack Shape

```json
{
  "domain": "writing",
  "skills": {
    "分析类": ["选题分析", "读者分析"],
    "生成类": ["大纲生成", "草稿生成"],
    "优化类": ["标题优化", "结构优化"],
    "发布类": ["平台适配", "发布复盘"]
  },
  "workflow_templates": [
    ["选题分析", "大纲生成", "草稿生成", "结构优化", "发布复盘"]
  ],
  "style_signals": [
    { "name": "结构化表达", "patterns": ["先", "再", "最后", "分步骤"] }
  ]
}
```

## Initial Domains

- `coding`
- `writing`
- `research`
- `learning`
- `product`
- `content`

## Agent Behavior

When a domain is detected, use the matching domain pack for interpretation. If confidence is low or the domain file is missing, fall back to `coding` and state the uncertainty.

## Runtime Behavior

- `nms ingest` loads `.nms/domains/*.json` before skill extraction.
- Only skills listed in a domain pack can be extracted; NMS must not invent domain skills.
- The detected domain is stored on the session and included in `.nms/derived/domains.json`.
- `nms flow --domain <name>` filters real sessions by stored domain.
- `nms context --format json` exposes `relevant_domains` for Agent routing.
- `nms report --format html --real-only` includes domain mix and workflow edges.

## Custom Domain Example

```json
{
  "domain": "fitness",
  "skills": {
    "准备类": ["热身"],
    "执行类": ["训练"],
    "复盘类": ["运动复盘"]
  },
  "workflow_templates": [["热身", "训练", "运动复盘"]],
  "style_signals": [
    { "name": "身体训练", "patterns": ["力量", "体能"] }
  ]
}
```
