# NMS v0.3 生产化升级执行文档

本文档给接手的 Agent 使用。目标不是继续做演示功能，而是把 NMS 从“能跑的 skill demo”升级为“可长期使用、可被 Agent 稳定调用、可审计、可扩展的个人行为操作系统”。

## 0. 执行前提

### 当前产品定位

NMS 的核心不是普通 CLI，也不是单个可视化页面，而是 `.nms` 用户行为数据层。

它要解决的问题是：

- 从真实对话压缩事件中学习用户行为。
- 将用户习惯、偏好、工作流转成 Agent 可执行上下文。
- 用安全边界约束 Agent 自动执行任务。
- 用报告和可视化让用户看到自己的工作方式、技能频率、进展和偏好演化。
- 从编程场景扩展到写作、研究、学习、内容创作、产品工作和个人管理。

### 当前已知状态

当前仓库已有以下基础能力：

- CLI：`ingest`、`flow`、`replay`、`night`、`doctor`、`report`。
- 存储：`.nms/data.json`，当前 `schema_version = 2`。
- Hook 管线：skill extraction、workflow builder、profile、cleaner。
- Flow dashboard：human/json 输出和基础 HTML 可视化。
- Night Harness：dry-run 状态机、测试、审查、Gate、权限 guard。
- Report：Markdown 报告和可选图片生成。

当前主要问题：

- 根 `SKILL.md` 和 `skills/nms-core/SKILL.md` 缺标准 YAML frontmatter。
- `.nms` 数据模型过于集中，缺事件日志、证据、置信度、隐私层、artifact 索引、profile patch。
- Agent 缺少专用上下文接口，不能稳定通过 `.nms` 理解用户习惯。
- Night Harness 的 rollback 存在 destructive git 风险，不能继续使用 `git reset --hard HEAD` 作为生产回滚策略。
- 报告和图片生成没有完整 artifact registry 和 prompt 留档机制。
- 当前能力偏编程场景，未抽象成 domain pack。

## 1. 硬性执行规则

接手 Agent 必须遵守：

- 先运行 `git status --short`，确认已有脏工作区，不得回滚用户或其他 Agent 的改动。
- 不得使用 fake demo data 填充生产路径；测试 fixture 可以存在于 `tests/fixtures/` 或临时目录，但不能污染 `.nms` 真实数据。
- 保持现有 CLI 向后兼容，除非文档明确要求新增 breaking change。
- 所有写入 `.nms` 的操作必须可恢复、可审计、可迁移。
- 不得在 apply/night 执行中使用 destructive rollback，例如 `git reset --hard`。
- 默认 dry-run，不得默认执行写仓库操作。
- 新增行为必须有测试覆盖，至少跑 `npm test` 和 `npm run build`。
- 不要把用户 API key、token、私密对话原文写入可提交文件。
- 如果要生成图片，必须先保存 prompt，再调用图像服务，生成结果必须登记为 artifact。

## 2. 目标版本定义

目标版本建议命名为 `v0.3`。

v0.3 成功标准：

- `nms ingest` 能写入 `.nms/events/*.jsonl`、`.nms/sessions/` 和 `.nms/derived/`，并兼容读取旧 `.nms/data.json`。
- `nms context --task "<task>" --format json` 能输出 Agent 可直接使用的用户上下文。
- `nms report --format html --real-only` 能生成基于真实 `.nms` 数据的 HTML 报告。
- `nms report --image` 能保存 prompt、图片和 artifact metadata。
- `nms night --dry-run --explain` 能输出完整 policy log、state log 和 gate 判定链。
- `nms night --apply` 仍需显式开启，且不能在 main 分支或未授权路径执行。
- `.nms` 数据有迁移、备份、隐私脱敏、原子写入。
- Skill 包符合标准 skill 结构，其他 Agent 能正确触发和使用。

## 3. 推荐目录结构

### 3.1 Skill 包结构

将当前 skill 包升级为以下结构：

```text
.
├── SKILL.md
├── agents/
│   └── openai.yaml
├── skills/
│   └── nms-core/
│       ├── SKILL.md
│       ├── manifest.json
│       ├── references/
│       │   ├── AGENT_PROTOCOL.md
│       │   ├── DATA_MODEL.md
│       │   ├── SAFETY.md
│       │   ├── REPORTING.md
│       │   └── DOMAIN_PACKS.md
│       └── assets/
│           └── report-template.html
```

要求：

- 根 `SKILL.md` 必须有 YAML frontmatter，仅包含 `name` 和 `description`。
- `description` 必须写清楚触发场景：用户行为学习、`.nms` 数据、workflow 可视化、Agent context、安全 dry-run、日报报告。
- `SKILL.md` 主体保持短，复杂协议放进 `skills/nms-core/references/`。
- `agents/openai.yaml` 用于 UI 展示，不要把大段实现细节塞进去。

### 3.2 `.nms` 数据结构

将 `.nms/data.json` 迁移为 v3 结构：

```text
.nms/
├── config.json
├── events/
│   └── 2026-05.jsonl
├── sessions/
│   └── 2026/
│       └── 05/
│           └── sess_xxx.json
├── derived/
│   ├── stats.json
│   ├── workflows.json
│   ├── profile.json
│   ├── agent-context.json
│   └── quality.json
├── artifacts/
│   ├── reports/
│   ├── images/
│   ├── prompts/
│   └── night-runs/
├── policies/
│   ├── safety.json
│   └── redaction.json
├── domains/
│   ├── coding.json
│   ├── writing.json
│   ├── research.json
│   ├── learning.json
│   ├── product.json
│   └── content.json
└── backups/
```

保留兼容：

- 如果只存在 `.nms/data.json`，启动时自动迁移。
- 迁移前将旧文件复制到 `.nms/backups/data-v2-<timestamp>.json`。
- 迁移后不要删除旧文件，除非用户显式执行 cleanup。

## 4. Phase 1：Skill 包装专业化

### 任务

1. 更新根 `SKILL.md`：
   - 添加 YAML frontmatter。
   - 精简主体，只保留快速入口和执行原则。
   - 明确 `/nms-*`、`$nms-*`、`nms` CLI 的关系。

2. 更新 `skills/nms-core/SKILL.md`：
   - 添加 YAML frontmatter。
   - 保留核心操作流。
   - 指向 `references/AGENT_PROTOCOL.md`、`DATA_MODEL.md`、`SAFETY.md`、`REPORTING.md`、`DOMAIN_PACKS.md`。

3. 新增 `agents/openai.yaml`：
   - `display_name`: `No More Skill`
   - `short_description`: 描述“行为学习 + Agent 上下文 + 安全执行 + 可视化报告”。
   - `default_prompt`: 给用户一个可直接触发的入口，例如“分析我的最近工作流并生成可视化报告”。

4. 新增 skill 内部 references：
   - `AGENT_PROTOCOL.md`：Agent 如何调用 `nms context`、`nms report`、`nms night`。
   - `DATA_MODEL.md`：`.nms` v3 数据结构和迁移规则。
   - `SAFETY.md`：apply、branch、path、secret、rollback 策略。
   - `REPORTING.md`：日报、周报、图片生成、artifact 留档。
   - `DOMAIN_PACKS.md`：非编程领域扩展方式。

### 验收标准

- Codex/Claude/OpenCode 能识别 skill。
- `SKILL.md` 不超过必要长度，复杂细节通过 references 渐进读取。
- `npm run release:validate` 如果存在，应通过。

## 5. Phase 2：`.nms` v3 数据层

### 目标

把 `.nms` 从单文件状态库升级为事件驱动数据层。

### 核心数据类型

新增或调整类型：

```ts
interface NmsEvent {
  event_id: string;
  type: "CONTEXT_COMPRESSED" | "PROFILE_PATCH" | "REPORT_GENERATED" | "NIGHT_RUN";
  created_at: string;
  project_id: string;
  source_tool: "codex" | "claude" | "opencode" | "unknown";
  input_hash: string;
  redaction_level: "safe" | "private" | "raw";
  payload_ref: string;
}
```

```ts
interface SessionV3 {
  id: string;
  created_at: string;
  project_id: string;
  domain: string;
  source_tool: string;
  compressed_text_ref?: string;
  conversation_ref?: string;
  skills: Array<{
    name: string;
    category: string;
    confidence: number;
    evidence: string[];
  }>;
  workflow: {
    steps: string[];
    edges: Array<{ from: string; to: string }>;
    confidence: number;
  };
  user_style_observations: Array<{
    claim: string;
    confidence: number;
    evidence: string[];
  }>;
}
```

```ts
interface ProfilePatch {
  id: string;
  created_at: string;
  claim: string;
  dimension: "style" | "preference" | "workflow" | "avoidance" | "domain";
  confidence: number;
  evidence_refs: string[];
  status: "draft" | "approved" | "rejected";
}
```

```ts
interface ArtifactRecord {
  artifact_id: string;
  type: "report" | "image" | "prompt" | "night-run" | "context";
  created_at: string;
  path: string;
  source_data_hash: string;
  real_data_only: boolean;
  metadata: Record<string, unknown>;
}
```

### 存储行为

实现要求：

- 写入必须 atomic：先写临时文件，再 rename。
- JSONL append 必须按月分片。
- derived 数据可以重建，events 和 sessions 是事实源。
- 每 50 次 ingest 或手动 `nms doctor --repair` 执行一次全量校准。
- 旧 v2 数据迁移到 v3 时，为每个旧 session 生成对应 event 和 session 文件。

### 建议实现文件

可以按以下方式拆分：

```text
src/storage/
├── index.ts
├── paths.ts
├── atomic.ts
├── migration.ts
├── events.ts
├── sessions.ts
├── derived.ts
├── artifacts.ts
└── redaction.ts
```

### 验收标准

- 空 `.nms` 可初始化。
- v2 `.nms/data.json` 可迁移。
- 重复 ingest 不重复写 session。
- 删除 `derived/` 后可通过 rebuild 恢复。
- 不会把 API key、Bearer token、`sk-` 样式密钥写入 session 明文。

## 6. Phase 3：Agent Context API

### 目标

让其他 Agent 不需要读 `.nms` 内部文件，也能稳定获得用户习惯和执行偏好。

### 新增命令

```bash
nms context --task "<task text>" --format json
nms context --task-file task.md --format json
nms context --format human
```

### JSON 输出协议

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-25T00:00:00.000Z",
  "project_id": "no-more-skill",
  "task_summary": "生成产品介绍视频",
  "user_style": {
    "communication": ["结构化", "直接", "偏好真实数据"],
    "workflow": ["先分析", "再实现", "再验证", "最后总结"],
    "avoid": ["demo 数据", "空泛描述", "跳过测试", "越权写文件"]
  },
  "relevant_workflows": [
    {
      "name": "产品分析 -> 可视化设计 -> 文档包装 -> 推广",
      "steps": ["产品分析", "可视化设计", "文档包装", "推广"],
      "confidence": 0.78,
      "evidence_refs": ["sess_xxx"]
    }
  ],
  "recommended_agent_behavior": [
    "先说明将读取哪些真实数据",
    "涉及写文件前说明改动范围",
    "生成报告时标注数据来源和样本量"
  ],
  "safety_policy": {
    "default_apply": false,
    "requires_explicit_apply": true,
    "allowed_write_roots": ["sandbox/", "feature/"],
    "blocked_patterns": [".env", "secrets", "private"]
  },
  "data_quality": {
    "sample_count": 0,
    "confidence": 0,
    "warnings": ["真实样本不足时不得编造"]
  }
}
```

### 隐私规则

- 默认不输出原始 conversation。
- 默认只输出 evidence ref，不输出长文本证据。
- 如果用户显式传 `--include-evidence`，也只能输出脱敏摘要。

### 验收标准

- 空数据时输出安全、诚实、可解析 JSON。
- 有数据时输出用户偏好、workflow、禁忌项、安全策略。
- Agent 可以直接把该 JSON 作为任务执行前上下文。

## 7. Phase 4：报告和可视化系统

### 目标

把报告从“生成一页好看 HTML”升级为“真实数据驱动的工作复盘系统”。

### 命令设计

```bash
nms report --period 1d --format html --real-only
nms report --period 7d --format md
nms report --period 30d --format json
nms report --period 7d --format html --image
```

### 报告内容

HTML 报告至少包含：

- 今日/本周概览。
- Skill 使用频率。
- 最近 workflow 路径图。
- 主 workflow 置信度。
- 工作进展摘要。
- 用户偏好变化草案。
- Agent 执行记录。
- 风险、阻塞、陈旧技能。
- 下一步建议，每条建议必须包含 `why` 和 `next_command`。
- 数据来源和样本量说明。

### 图片生成要求

学习 `baoyu-infographic` 的 prompt 留档机制：

1. 先从真实 `.nms` 数据生成 prompt。
2. 将 prompt 保存到 `.nms/artifacts/prompts/<slug>-<timestamp>.md`。
3. 再调用图像服务。
4. 将图片保存到 `.nms/artifacts/images/`。
5. 写入 artifact record。

如果真实数据不足：

- 报告必须显示“样本不足”。
- 图片 prompt 必须说明“基于有限真实数据，不补虚构指标”。
- 不允许自动生成假 skill 频率或假 workflow。

### 建议模板

新增：

```text
skills/nms-core/assets/report-template.html
```

模板设计方向：

- 适合视频展示。
- 视觉上像专业工作驾驶舱，不像普通后台表格。
- 支持无图片降级。
- 所有数字都来自真实 `.nms` derived 数据。

### 验收标准

- `nms report --format html --real-only` 生成可打开 HTML。
- HTML 中明确显示数据样本量。
- 图片生成前后都有 artifact 记录。
- 删除图片不影响报告基础内容。

## 8. Phase 5：Night Harness 安全生产化

### 当前风险

现有 rollback 不适合生产。必须移除 destructive rollback。

### 新策略

Night apply 必须使用隔离执行：

- 优先使用 Git worktree。
- 或使用 patch capture，仅回滚本次任务修改文件。
- 不得 reset 整个当前工作区。

### 执行流程

```text
PLAN
  -> POLICY_PRECHECK
  -> CREATE_SANDBOX
  -> EXECUTE
  -> TEST
  -> REVIEW_SPEC
  -> REVIEW_CODE
  -> GATE
  -> COMMIT or ROLLBACK_PATCH
```

### Policy Log

每次 night run 必须输出：

```json
{
  "run_id": "night_xxx",
  "apply": false,
  "branch": "night/dev-2026-05-25",
  "policy_checks": [
    {
      "name": "main_branch_guard",
      "status": "pass",
      "reason": "not on main"
    }
  ],
  "state_logs": [],
  "gate_decision": {
    "decision": "COMMIT",
    "because": ["tests passed", "spec reviewer approved", "code reviewer approved"]
  }
}
```

### 审查机制

保留双通道：

- `ReviewerSpec`：检查是否符合任务约束和用户偏好。
- `ReviewerCode`：检查复杂度、风格、风险、测试。

Gate：

```ts
if (!test.passed) return ROLLBACK;
if (!review.spec_approved || !review.code_approved) return ROLLBACK;
return COMMIT;
```

### 验收标准

- `nms night --dry-run --explain` 不写仓库。
- `nms night --apply` 在 main 分支阻断。
- 越权路径阻断。
- 测试失败阻断。
- 审查失败阻断。
- rollback 不影响用户已有未提交改动。

## 9. Phase 6：Domain Packs 非编程扩展

### 目标

将 NMS 从编程 skill 拓展为通用行为学习系统。

### Domain Pack 结构

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
    {
      "name": "结构化表达",
      "patterns": ["先", "再", "最后", "分步骤"]
    }
  ]
}
```

### 首批领域

- `coding`：代码分析、生成、调试、测试、评审。
- `writing`：选题、大纲、草稿、润色、发布。
- `research`：问题定义、资料收集、交叉验证、归纳、结论。
- `learning`：学习目标、资料、练习、反馈、复盘。
- `product`：需求、原型、文案、演示、推广。
- `content`：口播、分镜、页面、图片、发布。

### 验收标准

- `nms ingest` 能识别 domain。
- `nms flow --domain writing` 可输出写作相关 workflow。
- domain 配置缺失时降级到默认 coding，不报错。

## 10. Phase 7：测试计划

### 单元测试

覆盖：

- v2 -> v3 migration。
- JSONL event append。
- session idempotency。
- redaction。
- derived rebuild。
- context JSON 输出。
- report real-only 降级。
- artifact registry。
- write guard。
- night policy blocking。
- non-destructive rollback。

### E2E 测试

推荐命令链：

```bash
npm run build
npm test
node dist/cli.js ingest --input tests/fixtures/context-compressed-coding.json
node dist/cli.js flow --format json
node dist/cli.js context --task "生成一份项目周报" --format json
node dist/cli.js report --period 7d --format html --real-only
node dist/cli.js night --dry-run --explain --task-file tests/fixtures/night-task.json
node dist/cli.js doctor
```

### 安全测试

必须验证：

- `.env` 不被写入 artifact。
- `sk-xxx` 样式密钥会被脱敏。
- main 分支 apply 阻断。
- 非白名单路径阻断。
- 测试失败不 commit。
- 审查失败不 commit。
- rollback 不清除用户已有改动。

## 11. Release 验收清单

完成后检查：

- `npm run build` 通过。
- `npm test` 通过。
- `npm run release:check` 如果存在，应通过。
- README 更新 v0.3 能力说明。
- README 明确 `.nms` 是本地数据目录，不应提交隐私数据。
- README 明确如何安装到 Codex、Claude Code、OpenCode。
- `SKILL.md` frontmatter 有效。
- `agents/openai.yaml` 存在。
- `nms context` 有示例输出。
- `nms report --format html` 有真实数据样例截图或说明。
- 没有提交 API key。
- 没有提交真实 `.nms` 私密数据。

## 12. 建议提交拆分

不要把所有内容塞进一个 commit。建议拆分：

1. `skill: standardize nms skill packaging`
2. `storage: add nms v3 event-backed data model`
3. `cli: add agent context command`
4. `report: add real-data html reporting and artifact registry`
5. `harness: make night apply rollback non-destructive`
6. `domains: add behavior domain packs`
7. `docs: document production data and safety model`

## 13. 给执行 Agent 的最终提醒

NMS 的竞争力不在“看起来像一个 skill”，而在：

- 真实记录用户行为。
- 把行为变成 Agent 可用上下文。
- 在执行任务时尊重用户偏好。
- 在自动化时有硬安全边界。
- 用报告和图片让用户看见自己的工作方式正在进化。

不要优先堆 UI 特效。先把 `.nms` 数据可信度、Agent context 协议、安全回滚和真实报告做好。做到这四点，NMS 才能从 demo 变成用户愿意长期使用的个人行为操作台。
