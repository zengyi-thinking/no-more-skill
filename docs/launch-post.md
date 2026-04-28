# NMS Launch Post (CN)

## 标题（可选其一）

1. `no-more-skill 开源：把 Prompt 工程升级为 行为工程 + 执行系统`
2. `NMS 发布：白天学习行为，夜间受控代开发`

## 一句话介绍

`no-more-skill (NMS)` 是一个行为驱动的 CLI 系统：它从压缩上下文学习用户 workflow，并通过严格 Gate 的 Night Harness 在 dry-run 下安全模拟开发执行。

## 我们解决的问题

- 传统 prompt 工程缺少“长期行为记忆”和“可执行闭环”
- 多 agent 自动化缺少强约束，容易越权和失控
- 缺少一套能直接进 Git 工作流的安全默认策略

## 核心能力

- `nms ingest`：记录行为会话（skill/workflow/style）
- `nms flow`：输出最近 workflow、高频技能、下一步建议
- `nms replay`：复现最常用 workflow
- `nms night --dry-run`：按状态机跑 `PLAN -> EXECUTE -> TEST -> REVIEW -> GATE`
- `--apply` 显式开启，默认拒绝写入

## 安全边界（默认开启）

- 不允许跳过 TEST/REVIEW
- Gate 不通过自动回滚
- `max_retry = 3`
- 写入范围白名单 + 文件类型限制（UI/new/test）
- main 分支提交保护

## 快速开始

```bash
npm install
npm run build
npm run dev -- ingest --input input.json
npm run dev -- flow
npm run dev -- night --dry-run --time-budget 1
```

## 下一步路线

- v0.2: 强化 user_profile 与 auto skill
- v0.3: 受控 apply 的真实任务执行与更细粒度审查

## 仓库地址

`<在这里替换为你的 GitHub 仓库链接>`
