# no-more-skill (NMS)

默认语言：中文 | English: [README.en.md](./README.en.md)

![NMS Skill Hero](./images/nms-skill-hero.png)

NMS 不是“再写几个 Prompt”的工具，而是一个可持续进化的行为工程系统：
- 白天学习你的真实工作行为（skills/workflow/style）
- 夜间用受控状态机演练执行（PLAN -> EXECUTE -> TEST -> REVIEW -> GATE）
- 全程有安全护栏、可解释日志、可复盘指标
- 通过 `.nms` 本地数据层导出 Agent 可读上下文

一句话：**把 Prompt 工程升级为 行为工程 + 执行系统。**

## 为什么它有特色

1. 它学的是“行为轨迹”，不是只记一段提示词。
2. 它默认安全：`dry-run`、重试上限、写入白名单、分支保护。
3. 它越来越懂你：会形成主 workflow、给出下一步行动建议。
4. 它可审计：night 模式支持 `--explain`，清楚告诉你为什么通过/回滚。
5. 它不只服务编程：`domain pack` 能把写作、研究、学习、产品、内容创作等场景接入同一套行为模型。

## 核心能力

- `nms ingest`: 注入压缩上下文，提取 skill/workflow 并更新用户画像
- `nms flow`: 专业行为驾驶舱（支持 `--format human|json`）
- `nms context`: 导出 Agent 可直接使用的用户习惯上下文
- `nms replay`: 复现最常用 workflow
- `nms night`: 受控夜间执行（默认 dry-run，`--explain` 可解释判定链）
- `nms doctor`: 只读健康诊断（数据完整性、schema、git 安全状态）
- `nms report`: 生成真实使用周报（支持 Markdown/HTML/JSON，可选出图）

## 领域扩展：不只 Coding

NMS 会读取 `.nms/domains/*.json` 作为真实领域包。默认内置：

- `coding`：代码分析、UI 生成、代码生成、Debug、架构设计
- `writing`：选题分析、读者分析、大纲生成、草稿生成、标题优化、发布复盘
- `research`：问题定义、资料收集、交叉验证、来源评估、结论归纳
- `learning`：学习目标、资料选择、练习、反馈、学习复盘
- `product`：需求分析、用户分析、原型设计、文案设计、演示、推广
- `content`：口播、分镜、页面、图片、发布、复盘

你可以新增自己的领域包，例如 `.nms/domains/fitness.json`。只要压缩上下文里出现对应 skill，`ingest` 就会把它识别为真实领域数据，`flow --domain fitness` 和 `report` 会自动纳入统计。

## `.nms` 本地数据层

NMS v0.3 会在本地 `.nms/` 下保存真实行为数据：

- `.nms/events/`：压缩上下文、报告、night run 等事件日志
- `.nms/sessions/`：按年月拆分的真实会话行为记录
- `.nms/derived/`：可重建的统计、profile、workflow、agent context 快照
- `.nms/artifacts/`：报告、图片、prompt、night run 审计产物
- `.nms/policies/`：安全策略与脱敏策略
- `.nms/domains/`：coding/writing/research/learning/product/content 行为领域包

`.nms/data.json` 仍保留为兼容入口。旧数据会自动迁移到 v3 文件结构，并在 `.nms/backups/` 留备份。

> `.nms` 可能包含你的真实工作习惯和脱敏后的会话摘要。除非你明确知道自己在做什么，否则不要把真实 `.nms` 提交到公开仓库。

## 安装方式（Install Matrix）

| 方式 | 适合场景 | 命令 |
|---|---|---|
| `npx skills` | 通用、最快 | `npx skills add zengyi-thinking/no-more-skill` |
| Claude 插件市场 | Claude Code 用户 | `/plugin marketplace add zengyi-thinking/no-more-skill` |
| 本地开发安装 | 调试/二次开发 | `npm install && npm run build && npm link` |
| 固定版本 Zip | CI/可复现安装 | `npm run release:pack` 生成 `dist/releases/*.zip`（包含 marketplace + skill） |

### Skill 调用格式（Slash Route）

如果你的宿主环境习惯 `/<skill>-<function>`，可以直接使用：

- `/nms-ingest --input input.json`
- `/nms-flow --format human`
- `/nms-flow --visual`
- `/nms-context --task "生成一份项目周报" --format json`
- `/nms-replay`
- `/nms-night --dry-run --explain --task-file task.json`
- `/nms-doctor`
- `/nms-report --format html --real-only`
- `/nms-report --image`

如果你的宿主环境偏好 GSD 风格 `/<skill>:<function>`，也同样支持：

- `/nms:ingest`
- `/nms:flow`
- `/nms:replay`
- `/nms:night`
- `/nms:doctor`

如果你的宿主环境是 Codex 风格 `$<skill>-<function>`，也支持：

- `$nms-flow`
- `$nms-night --dry-run --task-file task.json`
- `$nms-report --image`

> 注意：在本地 PowerShell 终端里测试 `$nms-*` 时，需要加引号，例：`npm run dev:skill -- '$nms-flow' --format human`。在 Claude/Codex 宿主输入框里不需要引号。

运行时命令对照：

| Runtime | 命令风格 |
|---|---|
| Claude/Cursor/OpenCode | `/nms-flow` |
| GSD/Gemini 风格 | `/nms:flow` |
| Codex 风格 | `$nms-flow` |

本地入口命令：

```bash
npm run dev:skill -- /nms-flow --format json
npm run dev -- route --cmd nms-flow --args-json "{\"format\":\"json\"}"
```

Claude 插件市场安装后可直接执行：

```bash
/plugin install nms-skills@no-more-skill
```

## 安装与快速开始

```bash
npm install
npm run build
```

准备一个输入文件 `input.json`：

```json
{
  "compressed_text": "PRD分析 UI生成 代码生成",
  "conversation": "先 PRD分析，再 UI生成，最后 代码生成",
  "tool": "codex"
}
```

运行完整链路：

```bash
npm run dev -- ingest --input input.json
npm run dev -- flow
npm run dev -- flow --format json
npm run dev -- context --task "帮我生成本周项目报告" --format json
npm run dev -- flow --visual
npm run dev -- replay
npm run dev -- night --dry-run --explain --task-file task.json --time-budget 1
npm run dev -- doctor
npm run dev -- report --format html --real-only
```

## 输出长什么样

`nms flow` 默认输出：
- 行为评分（Behavior Score）
- workflow 置信度
- 7日活跃度
- 陈旧风险
- 连续使用天数
- 可执行建议（`why + next command`）

`nms flow --visual`：
- 生成本地 HTML 图表面板：`.nms/flow-dashboard.html`
- 展示领域分布、技能频率、主 workflow 路径和 workflow 转移边

`nms context --format json`：
- 输出用户沟通风格、常用 workflow、禁忌项、安全策略
- 输出 relevant domains，便于 Agent 判断当前任务更像 coding、writing、research 还是其他领域
- 适合 Agent 在执行任务前读取，而不是直接解析 `.nms` 内部文件

`nms report --format html --real-only`：
- 默认生成 `.nms/artifacts/reports/latest/report.md` 或 `report.html`
- HTML 报告包含领域分布、skill 频率、主 workflow 路径、workflow 边、用户风格和下一步命令

`nms report --image`：
- 调用你配置的中转站（默认模型 `gpt-image-2`）输出三张图：
  - `skill-frequency.png`
  - `work-progress.png`
  - `persona-evolution.png`
- 图片 prompt 先保存到 `.nms/artifacts/prompts/`
- 图片和报告登记到 `.nms/artifacts/artifacts.json`

中转站环境变量：
```bash
NMS_IMAGE_BASE_URL="https://api.apimart.ai/v1/images/generations"
NMS_IMAGE_API_KEY="<token>"
NMS_IMAGE_MODEL="gpt-image-2"
```

`nms night --explain` 默认输出：
- 状态流转日志（含耗时与决策）
- Gate 判定链
- 失败分级（`CONFIG_ERROR / POLICY_BLOCK / TEST_FAIL / REVIEW_FAIL / TIMEOUT`）

`task.json` 示例（真实任务输入）：
```json
{
  "task": "实现某个真实需求的夜间执行计划",
  "files": ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
  "constraints": ["仅允许 UI/new/test 范围内改动"],
  "test_plan": ["npm test"]
}
```

## 安全边界（默认开启）

- `--apply` 必须显式开启
- 不允许跳过 TEST/REVIEW
- `max_retry = 3`
- 写入仅允许白名单路径与受限文件类型（UI/new/test）
- main 分支提交保护
- rollback 不会重置整个用户工作区
- 报告和图片只使用真实 `.nms` 数据；样本不足时会明确说明

## 项目结构

- `src/hook/*`：行为提取与收敛
- `src/harness/*`：夜间状态机与 Gate
- `src/commands.ts`：CLI 命令实现
- `tests/nms.test.ts`：核心测试
- `SKILL.md`：Skill 规范入口
- `skills/nms-core/references/*`：Agent 协议、数据模型、安全、报告、领域包

## 适合谁

- 想把 AI 使用从“偶尔好用”变成“稳定可复用”的个人开发者
- 需要把 AI 自动化接入工程流程的技术团队
- 想做可解释、可审计、可持续学习的 Agent 产品原型
