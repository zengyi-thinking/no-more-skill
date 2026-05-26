# no-more-skill (NMS)

默认语言：中文 | English: [README.en.md](./README.en.md)

![NMS Skill Hero](./images/nms-skill-hero.png)

NMS 不是“再写几个 Prompt”的工具，而是一个可持续进化的行为工程系统：
- 白天学习你的真实工作行为（skills/workflow/style）
- 夜间用受控状态机演练执行（PLAN -> EXECUTE -> TEST -> REVIEW -> GATE）
- 全程有安全护栏、可解释日志、可复盘指标
- 通过 `.nms` 本地数据层导出 Agent 可读上下文

一句话：**把 Prompt 工程升级为 行为工程 + 执行系统。**

## 30 秒开始使用

安装后先输入：

```bash
/nms
```

它会根据当前 `.nms` 数据状态给你下一步。如果是空数据，NMS 会明确提示“还在学习”，不会编造画像。最短路径：

1. 喂入一条真实压缩事件：让 Agent 调用 NMS ingest，或本地运行 `nms ingest --input input.json`
2. 看行为驾驶舱：`/nms-flow`
3. 让 Agent 安全模拟执行：`/nms-auto`
4. 生成可继承资产：`/nms-birthday`

## 为什么它有特色

1. 它学的是“行为轨迹”，不是只记一段提示词。
2. 它默认安全：`dry-run`、重试上限、写入白名单、分支保护。
3. 它越来越懂你：会形成主 workflow、给出下一步行动建议。
4. 它可审计：`/nms-auto` 会输出 dry-run Gate 判定链，清楚告诉你为什么通过/回滚。
5. 它不只服务编程：`domain pack` 能把写作、研究、学习、产品、内容创作等场景接入同一套行为模型。

## 用户主入口

普通用户只需要记住四个命令：

- `/nms-flow`：看趋势。展示最近 workflow、skill 频率、用户风格和数据健康度。
- `/nms-report`：出报告。生成真实 `.nms` 数据驱动的 HTML 可视化报告。
- `/nms-auto`：安全自动推进。读取 `.nms` 习惯，先模拟用户 workflow，再走 dry-run Gate。
- `/nms-birthday`：生成“生日记忆胶囊”，把年度目标、边界和进化信号写成后续 Agent 可继承的资产。

`/nms-birthday` 不是一次性总结页，它会写入 `.nms/derived/birthday/latest.json`，后续 `/nms-auto` 会通过 Agent Context 自动继承这份 North Star 和下一阶段目标。

## Agent 工作流

内部步骤不再要求用户记命令。`/nms-auto` 会像一个谨慎的开发 Agent 一样自动完成：

- 读取 `.nms` 行为记忆和用户风格
- 生成任务前简报和 workflow 选择
- 检查当前写入边界和 Git 待改文件
- 运行 dry-run Gate，并给出通过/阻断原因
- 输出下一步应该怎么做

## 领域扩展：不只 Coding

NMS 会读取 `.nms/domains/*.json` 作为真实领域包。默认内置：

- `coding`：代码分析、UI 生成、代码生成、Debug、架构设计
- `writing`：选题分析、读者分析、大纲生成、草稿生成、标题优化、发布复盘
- `research`：问题定义、资料收集、交叉验证、来源评估、结论归纳
- `learning`：学习目标、资料选择、练习、反馈、学习复盘
- `product`：需求分析、用户分析、原型设计、文案设计、演示、推广
- `content`：口播、分镜、页面、图片、发布、内容复盘

你可以新增自己的领域包，例如 `.nms/domains/fitness.json`。只要压缩上下文里出现对应 skill，`ingest` 就会把它识别为真实领域数据，`flow --domain fitness` 和 `report` 会自动纳入统计。

## `.nms` 本地数据层

NMS v0.4 会在本地 `.nms/` 下保存真实行为数据：

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

如果你的宿主环境习惯 `/<skill>-<function>`，普通用户只需要直接调用：

- `/nms-flow`
- `/nms-report`
- `/nms-auto`
- `/nms-birthday`

这三个命令会自动调用内部能力。比如 `/nms-auto` 会透明使用 brief、suggest、guard 和 night gate；用户不需要记住这些内部步骤。

如果你的宿主环境偏好 GSD 风格 `/<skill>:<function>`，也同样支持：

- `/nms:flow`
- `/nms:report`
- `/nms:auto`
- `/nms:birthday`

如果你的宿主环境是 Codex 风格 `$<skill>-<function>`，也支持：

- `$nms-flow`
- `$nms-report`
- `$nms-auto`
- `$nms-birthday`

> 注意：在本地 PowerShell 终端里测试 `$nms-*` 时，需要加引号，例：`npm run dev:skill -- '$nms-flow'`。在 Claude/Codex 宿主输入框里不需要引号。

运行时命令对照：

| Runtime | 命令风格 |
|---|---|
| Claude/Cursor/OpenCode | `/nms-flow` |
| GSD/Gemini 风格 | `/nms:flow` |
| Codex 风格 | `$nms-flow` |

本地入口命令：

```bash
npm run dev:skill -- /nms-flow
npm run dev -- route --cmd nms-flow
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
npm run dev -- report
npm run dev -- auto
npm run dev -- birthday
```

## 输出长什么样

`nms flow` 默认输出：
- 行为评分（Behavior Score）
- workflow 置信度
- 7日活跃度
- 陈旧风险
- 连续使用天数
- 可执行建议（`why + next command`）

`nms report`：
- 默认生成 `.nms/artifacts/reports/latest/report.md` 或 `report.html`
- HTML 报告包含领域分布、skill 频率、主 workflow 路径、workflow 边、用户风格和下一步命令
- 默认生成 HTML 周报；高级自动化仍可指定 daily/weekly/video/portfolio 模板

`nms auto`：
- 默认 dry-run，不会直接写仓库
- 内部读取行为记忆、推断 workflow、检查写入边界，再进入 dry-run Gate
- 只输出用户需要看的摘要、Gate 结果和下一步建议，不暴露内部命令细节

`nms birthday`：
- 生成 `.nms/derived/birthday/latest.json` 作为可继承记忆胶囊
- 生成 `.nms/artifacts/birthday/latest/birthday.html` 作为生日/年度进化页面
- 后续 `nms context` 和 `/nms-auto` 会读取 `birthday_memory`

Agent 内部能力仍然存在，但默认被 `/nms-auto` 接管，不需要普通用户主动记忆。

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

`nms night` 默认输出：
- 状态流转日志（含耗时与决策）
- Gate 判定链
- 失败分级（`CONFIG_ERROR / POLICY_BLOCK / TEST_FAIL / REVIEW_FAIL / TIMEOUT`）
- 无参数时自动根据 `.nms` 最近行为生成 dry-run 计划
- 生产 apply 必须使用人工审查过的 `--task-file`

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
