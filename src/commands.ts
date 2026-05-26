import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { z } from "zod";
import { DEFAULT_CONFIG } from "./config.js";
import { validateWriteScope } from "./harness/guards.js";
import { readPlannerInput, runNightHarness } from "./harness/engine.js";
import { processCompressedEvent } from "./hook/engine.js";
import { detectDomainFromText, detectSessionDomain, domainPackFor } from "./hook/domainPacks.js";
import { JsonStorage } from "./storage.js";
import { State } from "./types.js";
import type { AgentContext, BirthdayCapsule, HookInput, NightReport, PlannerOutput, SessionRecord, Stats } from "./types.js";

const InputSchema = z.object({
  compressed_text: z.string(),
  conversation: z.string(),
  tool: z.enum(["claude", "codex", "opencode"])
});

type ReportTemplate = "daily" | "weekly" | "video" | "portfolio";

function readPayload(inputFile?: string): string {
  if (inputFile) return fs.readFileSync(inputFile, "utf8");
  return fs.readFileSync(0, "utf8");
}

function defaultTaskSummary(storage: JsonStorage): string {
  const db = storage.load();
  const topWorkflow = db.user_profile.top_workflows[0] ?? Object.entries(db.stats.workflow_counts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topWorkflow) return `Continue from the most stable NMS workflow: ${topWorkflow}`;
  const topDomain = Object.entries(db.stats.domain_counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topDomain) return `Continue work in the user's strongest observed domain: ${topDomain}`;
  return "Inspect current NMS behavior context and prepare the next safe action";
}

export function ingestCommand(inputFile?: string): string {
  const raw = readPayload(inputFile);
  const parsed = InputSchema.parse(JSON.parse(raw)) as HookInput;
  const out = processCompressedEvent(parsed);
  return JSON.stringify(out, null, 2);
}

export function ingestGuideCommand(): string {
  return [
    "== NMS Ingest ==",
    "This command needs a real compressed event. NMS will not create demo behavior data.",
    "Use one of these real-data inputs:",
    "- /nms-ingest --input input.json",
    "- nms ingest --input input.json",
    "- cat input.json | nms ingest",
    "Required payload:",
    "{\"compressed_text\":\"...\",\"conversation\":\"...\",\"tool\":\"claude|codex|opencode\"}"
  ].join("\n");
}

export function onboardingCommand(format: "human" | "json" = "human"): string {
  const data = JSON.parse(dataStatusCommand("json")) as {
    sample_count: number;
    latest_session_at: string | null;
    quality: Stats["quality_metrics"];
    warnings: string[];
  };
  const status = data.sample_count === 0
    ? "not_started"
    : data.quality.workflow_confidence < 0.5
      ? "learning"
      : "ready";
  const steps = data.sample_count === 0
    ? [
        {
          title: "喂入第一条真实行为",
          why: "NMS 不使用 demo 数据；没有真实 compress 事件时不会推断你的偏好。",
          command: "让 Agent 调用 NMS ingest，或本地运行：nms ingest --input input.json"
        },
        {
          title: "查看行为驾驶舱",
          why: "确认 skill、workflow、style 是否从真实数据里长出来。",
          command: "/nms-flow"
        },
        {
          title: "生成第一个可继承资产",
          why: "birthday capsule 会被后续 /nms-auto 继承。",
          command: "/nms-birthday"
        }
      ]
    : [
        {
          title: "看趋势",
          why: "先确认最近 workflow、skill 频率和数据健康度。",
          command: "/nms-flow"
        },
        {
          title: "让 Agent 安全模拟执行",
          why: "它会隐藏读取 context、brief、suggest、guard、night gate 的内部流程。",
          command: "/nms-auto"
        },
        {
          title: "生成可展示报告或生日胶囊",
          why: "报告用于展示，birthday memory 用于长期继承。",
          command: "/nms-report 或 /nms-birthday"
        }
      ];
  const payload = {
    entry: "/nms",
    status,
    data_quality: {
      sample_count: data.sample_count,
      latest_session_at: data.latest_session_at,
      behavior_score: data.quality.behavior_score,
      workflow_confidence: data.quality.workflow_confidence,
      stale_risk: data.quality.stale_risk,
      warnings: data.warnings
    },
    user_commands: ["/nms-flow", "/nms-report", "/nms-auto", "/nms-birthday"],
    thirty_second_path: steps,
    principle: "Use real .nms data only. Empty data is a learning state, not an error."
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS 30 秒上手 / 30-Second Start ==",
    `Status: ${status}`,
    `Samples: ${payload.data_quality.sample_count}`,
    `Behavior Score: ${payload.data_quality.behavior_score}`,
    `Workflow Confidence: ${payload.data_quality.workflow_confidence}`,
    payload.principle,
    "",
    "== 你只需要记住这四个入口 ==",
    "- /nms-flow      看趋势和 skill/workflow 频率",
    "- /nms-report    生成真实数据报告",
    "- /nms-auto      让 Agent 读取习惯并安全 dry-run",
    "- /nms-birthday  生成可继承的生日记忆胶囊",
    "",
    "== 下一步 / Next Steps ==",
    ...steps.map((step, index) => `${index + 1}. ${step.title}\nwhy: ${step.why}\nnext: ${step.command}`),
    "",
    "Internal Agent steps stay hidden behind /nms-auto."
  ].join("\n");
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

function readArtifactRegistry(storage: JsonStorage): unknown[] {
  const registryPath = path.join(storage.root, "artifacts", "artifacts.json");
  if (!fs.existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function countFiles(root: string, suffix?: string): number {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) count += 1;
    }
  };
  visit(root);
  return count;
}

function parsePeriodDays(period = "7d"): number | undefined {
  if (period === "all") return undefined;
  const match = /^(\d+)d$/i.exec(period.trim());
  if (!match) return 7;
  return Math.max(1, Number(match[1]));
}

function filterSessionsByPeriod(sessions: SessionRecord[], period = "7d"): SessionRecord[] {
  const days = parsePeriodDays(period);
  if (!days) return sessions;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter((session) => new Date(session.created_at).getTime() >= cutoff);
}

function sessionCounts(sessions: SessionRecord[]): {
  skillCounts: Record<string, number>;
  workflowCounts: Record<string, number>;
  domainCounts: Record<string, number>;
} {
  const skillCounts: Record<string, number> = {};
  const workflowCounts: Record<string, number> = {};
  const domainCounts: Record<string, number> = {};
  for (const session of sessions) {
    for (const skill of session.skills_used) skillCounts[skill] = (skillCounts[skill] ?? 0) + 1;
    const workflow = session.workflow.join(" -> ");
    if (workflow) workflowCounts[workflow] = (workflowCounts[workflow] ?? 0) + 1;
    const domain = session.domain ?? "coding";
    domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
  }
  return { skillCounts, workflowCounts, domainCounts };
}

function reportQualityMetrics(
  sessions: SessionRecord[],
  workflowCounts: Record<string, number>
): Stats["quality_metrics"] {
  if (sessions.length === 0) {
    return {
      behavior_score: 0,
      workflow_confidence: 0,
      session_velocity_7d: 0,
      stale_risk: 100,
      streak_days: 0
    };
  }
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const recentCount = sessions.filter((session) => now - new Date(session.created_at).getTime() <= sevenDays).length;
  const topWorkflowCount = Object.values(workflowCounts).reduce((max, value) => Math.max(max, value), 0);
  const confidence = topWorkflowCount / sessions.length;
  const daySet = new Set(sessions.map((session) => session.created_at.slice(0, 10)));
  return {
    behavior_score: Math.min(100, Math.round(confidence * 60 + Math.min(1, recentCount / 14) * 40)),
    workflow_confidence: Number(confidence.toFixed(3)),
    session_velocity_7d: Number((recentCount / 7).toFixed(2)),
    stale_risk: recentCount === 0 ? 100 : 0,
    streak_days: daySet.size
  };
}

function topEntries(record: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function sessionsWithinDays(sessions: SessionRecord[], days: number, offsetDays = 0): SessionRecord[] {
  const end = Date.now() - offsetDays * 24 * 60 * 60 * 1000;
  const start = end - days * 24 * 60 * 60 * 1000;
  return sessions.filter((session) => {
    const t = new Date(session.created_at).getTime();
    return t >= start && t < end;
  });
}

function bar(value: number, max = 100, width = 24): string {
  const safe = Math.max(0, Math.min(value, max));
  const fill = Math.round((safe / max) * width);
  return `[${"#".repeat(fill)}${".".repeat(Math.max(0, width - fill))}] ${safe}/${max}`;
}

function formatWorkflowTrail(recent: string[][]): string {
  if (recent.length === 0) return "(no workflow yet)";
  return recent
    .map((wf, idx) => `${idx + 1}. ${wf.length > 0 ? wf.join(" -> ") : "(empty)"}`)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function workflowEdgeCounts(sessions: SessionRecord[]): Array<{ from: string; to: string; count: number }> {
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const session of sessions) {
    for (let i = 0; i < session.workflow.length - 1; i += 1) {
      const from = session.workflow[i];
      const to = session.workflow[i + 1];
      const key = `${from} -> ${to}`;
      const existing = counts.get(key) ?? { from, to, count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function normalizeReportTemplate(template?: string): ReportTemplate {
  if (template === "daily" || template === "video" || template === "portfolio") return template;
  return "weekly";
}

function reportTemplateCopy(template: ReportTemplate): { title: string; description: string; mdHeading: string } {
  const copies: Record<ReportTemplate, { title: string; description: string; mdHeading: string }> = {
    daily: {
      title: "Daily Operating Brief",
      description: "聚焦今天/近期的真实行为信号，适合每日复盘和明日行动安排。",
      mdHeading: "每日行动简报"
    },
    weekly: {
      title: "Weekly Behavior Cockpit",
      description: "聚焦周期内的领域分布、技能频率、workflow 稳定性和下一步建议。",
      mdHeading: "周度行为驾驶舱"
    },
    video: {
      title: "Video Presentation Script",
      description: "为 3-5 分钟产品讲解准备：一句话定位、三段亮点、演示路径和收尾口播。",
      mdHeading: "视频讲解模板"
    },
    portfolio: {
      title: "Portfolio Evidence Board",
      description: "把真实行为数据整理成可展示的作品证据：能力、流程、产出和安全边界。",
      mdHeading: "作品集证据板"
    }
  };
  return copies[template];
}

function reportTemplateMarkdown(template: ReportTemplate, topDomains: [string, number][], topWorkflows: [string, number][]): string {
  if (template === "video") {
    return [
      "## 视频讲解结构",
      "",
      "1. 开场：NMS 不是 prompt 收藏夹，而是让 Agent 学会真实工作方式的行为系统。",
      "2. 展示：打开 flow/report，看领域分布、skill 频率和 workflow 路径。",
      "3. 证明：调用 context/guard/night，说明 Agent 能读偏好、守边界、先 dry-run。",
      "4. 收尾：强调所有指标来自真实 `.nms` 数据，样本不足不会编造。",
      "",
      `推荐主线：${topWorkflows[0]?.[0] ?? "暂无稳定 workflow"}`,
      `主要领域：${topDomains[0]?.[0] ?? "暂无领域样本"}`
    ].join("\n");
  }
  if (template === "daily") {
    return [
      "## 今日行动简报",
      "",
      "- 今天优先复用最高置信 workflow。",
      "- 若样本不足，先采集真实 ingest，再让 Agent 执行。",
      "- 写文件前先运行 `nms guard --files ...`。"
    ].join("\n");
  }
  if (template === "portfolio") {
    return [
      "## 作品集证据板",
      "",
      "- 能力证据：Top skills 来自真实会话频率。",
      "- 流程证据：Workflow path 来自真实执行顺序。",
      "- 安全证据：Night harness 默认 dry-run 且有 Gate。",
      "- 可信证据：报告 artifact 已登记到 `.nms/artifacts/artifacts.json`。"
    ].join("\n");
  }
  return [
    "## 周度复盘焦点",
    "",
    "- 本周看领域分布是否集中。",
    "- 看主 workflow 置信度是否提升。",
    "- 看陈旧风险是否需要刷新样本。",
    "- 根据下一步命令继续推进。"
  ].join("\n");
}

function reportTemplateHtml(template: ReportTemplate, topDomains: [string, number][], topWorkflows: [string, number][]): string {
  const copy = reportTemplateCopy(template);
  const workflow = escapeHtml(topWorkflows[0]?.[0] ?? "暂无稳定 workflow");
  const domain = escapeHtml(topDomains[0]?.[0] ?? "暂无领域样本");
  const body: Record<ReportTemplate, string> = {
    video: `
      <div class="step"><div class="dot">1</div><div><strong>开场定位</strong><div class="muted">NMS 不是 prompt 收藏夹，而是个人 Agent 行为操作台。</div></div></div>
      <div class="step"><div class="dot">2</div><div><strong>数据展示</strong><div class="muted">展示领域分布、skill 频率、主 workflow：${workflow}。</div></div></div>
      <div class="step"><div class="dot">3</div><div><strong>可信证明</strong><div class="muted">强调 report/context/guard/night 都读取真实 .nms 数据。</div></div></div>
      <div class="step"><div class="dot">4</div><div><strong>收尾口播</strong><div class="muted">让 Agent 越用越懂你，但永远先守安全边界。</div></div></div>`,
    daily: `
      <div class="step"><div class="dot">1</div><div><strong>今日主领域</strong><div class="muted">${domain}</div></div></div>
      <div class="step"><div class="dot">2</div><div><strong>下一步动作</strong><div class="muted">先刷新真实样本，再复用主 workflow。</div></div></div>
      <div class="step"><div class="dot">3</div><div><strong>执行前检查</strong><div class="muted">写文件前运行 nms guard。</div></div></div>`,
    weekly: `
      <div class="step"><div class="dot">1</div><div><strong>主领域</strong><div class="muted">${domain}</div></div></div>
      <div class="step"><div class="dot">2</div><div><strong>主 workflow</strong><div class="muted">${workflow}</div></div></div>
      <div class="step"><div class="dot">3</div><div><strong>复盘重点</strong><div class="muted">观察 workflow confidence、stale risk 和下一步建议。</div></div></div>`,
    portfolio: `
      <div class="step"><div class="dot">1</div><div><strong>能力证据</strong><div class="muted">Top skills 由真实 session 频率支撑。</div></div></div>
      <div class="step"><div class="dot">2</div><div><strong>流程证据</strong><div class="muted">Workflow path 由真实执行顺序支撑。</div></div></div>
      <div class="step"><div class="dot">3</div><div><strong>安全证据</strong><div class="muted">Night harness 默认 dry-run，apply 受白名单和 Gate 约束。</div></div></div>`
  };
  return `<section class="card"><h2>${copy.title}</h2><p class="muted">${copy.description}</p><div class="timeline">${body[template]}</div></section>`;
}

function flowSuggestions(db: ReturnType<JsonStorage["load"]>): Array<{ title: string; why: string; next_command: string }> {
  const suggestions: Array<{ title: string; why: string; next_command: string }> = [];
  if (db.sessions.length === 0) {
    suggestions.push({
      title: "开始积累行为样本",
      why: "当前无会话数据，系统无法形成稳定 workflow。",
      next_command: "nms ingest --input input.json"
    });
    return suggestions;
  }
  if (db.stats.quality_metrics.workflow_confidence < 0.6) {
    suggestions.push({
      title: "收敛主流程",
      why: "主 workflow 置信度偏低，说明流程抖动较大。",
      next_command: "nms replay"
    });
  }
  if (db.stats.quality_metrics.stale_risk >= 60) {
    suggestions.push({
      title: "刷新陈旧技能",
      why: "技能陈旧风险较高，建议用近期真实任务覆盖。",
      next_command: "nms ingest --input input.json"
    });
  }
  if (suggestions.length === 0) {
    suggestions.push({
      title: "保持节奏",
      why: "行为稳定度较高，可继续复用主 workflow。",
      next_command: "nms replay"
    });
  }
  return suggestions;
}

export function flowCommand(format: "human" | "json" = "human", options?: { domain?: string }): string {
  const started = performance.now();
  const storage = new JsonStorage();
  const db = storage.load();
  const packs = storage.loadDomainPacks();
  const domain = options?.domain;
  const sessionsWithDomains = db.sessions.map((session) => ({
    ...session,
    domain: detectSessionDomain(session, packs)
  }));
  const scopedSessions = domain ? sessionsWithDomains.filter((s) => s.domain === domain) : sessionsWithDomains;
  const recent = [...scopedSessions]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 3)
    .map((s) => s.workflow);
  const skillCounts = domain
    ? scopedSessions.reduce<Record<string, number>>((acc, session) => {
        for (const skill of session.skills_used) acc[skill] = (acc[skill] ?? 0) + 1;
        return acc;
      }, {})
    : db.stats.skill_counts;
  const skillEntries = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]);
  const topSkills = skillEntries.slice(0, 5).map(([k, v]) => `${k}(${v})`);
  const idleSkills = skillEntries.slice(5).map(([k]) => k);
  const suggestions = flowSuggestions(db);
  const scopedCounts = sessionCounts(scopedSessions);
  const domainSummary = Object.entries(domain ? scopedCounts.domainCounts : db.stats.domain_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  const payload = {
    recent_workflow: recent,
    domain: domain ?? "all",
    domain_summary: domainSummary,
    top_skills: topSkills,
    idle_skills: idleSkills,
    next_suggestions: suggestions,
    quality: db.stats.quality_metrics,
    perf_health: {
      ingest_avg_ms: avg(db.stats.perf_windows.ingest_ms),
      flow_avg_ms: avg(db.stats.perf_windows.flow_ms),
      night_avg_ms: avg(db.stats.perf_windows.night_ms)
    }
  };
  storage.trackPerf("flow_ms", Number((performance.now() - started).toFixed(2)));

  if (format === "json") return JSON.stringify(payload, null, 2);

  return [
    "== NMS 行为驾驶舱 / Behavior Cockpit ==",
    `Domain: ${domain ?? "all"}`,
    `Behavior Score      ${bar(db.stats.quality_metrics.behavior_score)}`,
    `Workflow Confidence ${bar(Math.round(db.stats.quality_metrics.workflow_confidence * 100))}`,
    `Session Velocity(7d): ${db.stats.quality_metrics.session_velocity_7d}`,
    `Stale Risk: ${db.stats.quality_metrics.stale_risk}%`,
    `Streak Days: ${db.stats.quality_metrics.streak_days}`,
    "== 最近 workflow 轨迹 / Recent Workflow Trail ==",
    formatWorkflowTrail(recent),
    "== 领域分布 / Domain Mix ==",
    domainSummary.map((item) => `${item.name}(${item.count})`).join(", ") || "(none)",
    "== 高频技能 / Top Skills ==",
    topSkills.join(", ") || "(none)",
    "== 闲置技能 / Idle Skills ==",
    idleSkills.join(", ") || "(none)",
    "== 可执行建议 / Actionable Suggestions ==",
    ...suggestions.map((s, i) => `${i + 1}) ${s.title}\nwhy: ${s.why}\nnext: ${s.next_command}`),
    "== 系统健康 / Perf Health ==",
    `ingest_avg_ms=${avg(db.stats.perf_windows.ingest_ms)}, flow_avg_ms=${avg(
      db.stats.perf_windows.flow_ms
    )}, night_avg_ms=${avg(db.stats.perf_windows.night_ms)}`
  ].join("\n");
}

export function contextCommand(options?: {
  task?: string;
  taskFile?: string;
  format?: "human" | "json";
  includeEvidence?: boolean;
}): string {
  const storage = new JsonStorage();
  const task = options?.taskFile ? fs.readFileSync(options.taskFile, "utf8") : options?.task ?? "";
  const context = storage.buildAgentContext(task.trim());
  const contextPath = path.join(storage.root, "artifacts", "night-runs", `context-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");
  storage.recordArtifact({
    type: "context",
    path: path.relative(storage.root, contextPath).replaceAll("\\", "/"),
    source_data_hash: sha256(JSON.stringify(context)),
    real_data_only: true,
    metadata: {
      task_summary: context.task_summary,
      include_evidence: Boolean(options?.includeEvidence)
    }
  });

  if (options?.format === "json") return JSON.stringify(context, null, 2);
  return [
    "== NMS Agent Context ==",
    `Project: ${context.project_id}`,
    `Task: ${context.task_summary}`,
    `Samples: ${context.data_quality.sample_count}`,
    `Confidence: ${context.data_quality.confidence}`,
    `Style: ${context.user_style.communication.join(", ")}`,
    `Avoid: ${context.user_style.avoid.join(", ")}`,
    "Recommended Agent Behavior:",
    ...context.recommended_agent_behavior.map((item, index) => `${index + 1}. ${item}`),
    "Relevant Workflows:",
    ...(context.relevant_workflows.length > 0
      ? context.relevant_workflows.map((wf, index) => `${index + 1}. ${wf.name} (${wf.confidence})`)
      : ["(no stable workflow yet)"]),
    "Relevant Domains:",
    ...(context.relevant_domains.length > 0
      ? context.relevant_domains.map((domain, index) => `${index + 1}. ${domain.name} (${domain.count}, ${domain.confidence})`)
      : ["(no stable domain yet)"]),
    "Birthday Memory:",
    ...(context.birthday_memory
      ? [
          `North Star: ${context.birthday_memory.north_star}`,
          `Targets: ${context.birthday_memory.next_year_targets.join(", ") || "(none)"}`
        ]
      : ["(none yet)"]),
    "Warnings:",
    ...(context.data_quality.warnings.length > 0 ? context.data_quality.warnings : ["(none)"])
  ].join("\n");
}

export function dataStatusCommand(format: "human" | "json" = "human"): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const artifacts = readArtifactRegistry(storage);
  const sessions = [...db.sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const latest = sessions[0];
  const domainEntries = Object.entries(db.stats.domain_counts).sort((a, b) => b[1] - a[1]);
  const warnings: string[] = [];
  if (db.sessions.length === 0) warnings.push("No real sessions yet; do not infer user preferences.");
  if (db.stats.quality_metrics.workflow_confidence < 0.5) warnings.push("Workflow confidence is low; keep suggestions tentative.");
  if (db.stats.quality_metrics.stale_risk >= 60) warnings.push("High stale risk; refresh with recent ingest data.");

  const payload = {
    schema_version: db.schema_version,
    root: storage.root,
    sample_count: db.sessions.length,
    latest_session_at: latest?.created_at ?? null,
    domain_coverage: domainEntries.map(([name, count]) => ({ name, count })),
    top_skills: Object.entries(db.stats.skill_counts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    top_workflows: Object.entries(db.stats.workflow_counts).sort((a, b) => b[1] - a[1]).slice(0, 5),
    quality: db.stats.quality_metrics,
    facts: {
      event_files: countFiles(path.join(storage.root, "events"), ".jsonl"),
      session_files: countFiles(path.join(storage.root, "sessions"), ".json"),
      artifact_records: artifacts.length,
      domain_packs: storage.loadDomainPacks().length
    },
    warnings
  };

  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Data Status ==",
    `schema_version=${payload.schema_version}`,
    `root=${payload.root}`,
    `samples=${payload.sample_count}`,
    `latest_session_at=${payload.latest_session_at ?? "(none)"}`,
    `domain_coverage=${payload.domain_coverage.map((item) => `${item.name}(${item.count})`).join(", ") || "(none)"}`,
    `quality=behavior:${payload.quality.behavior_score}, workflow_confidence:${payload.quality.workflow_confidence}, stale:${payload.quality.stale_risk}%`,
    `facts=events:${payload.facts.event_files}, sessions:${payload.facts.session_files}, artifacts:${payload.facts.artifact_records}, domains:${payload.facts.domain_packs}`,
    "warnings:",
    ...(warnings.length > 0 ? warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}

export function profileReviewCommand(format: "human" | "json" = "human"): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const totalSessions = Math.max(1, db.sessions.length);
  const claims = [
    ...db.user_profile.top_skills.map((skill) => ({
      dimension: "skill",
      claim: `User frequently uses ${skill}`,
      confidence: Number(((db.stats.skill_counts[skill] ?? 0) / totalSessions).toFixed(3)),
      evidence_refs: db.sessions.filter((session) => session.skills_used.includes(skill)).slice(0, 3).map((session) => session.id),
      status: "draft"
    })),
    ...db.user_profile.top_workflows.map((workflow) => ({
      dimension: "workflow",
      claim: `User often follows workflow: ${workflow}`,
      confidence: Number(((db.stats.workflow_counts[workflow] ?? 0) / totalSessions).toFixed(3)),
      evidence_refs: db.sessions.filter((session) => session.workflow.join(" -> ") === workflow).slice(0, 3).map((session) => session.id),
      status: "draft"
    })),
    {
      dimension: "style",
      claim: db.user_profile.style === "unknown" ? "User style is not stable yet" : `User communication style: ${db.user_profile.style}`,
      confidence: db.user_profile.style === "unknown" ? 0 : Math.min(1, db.sessions.length / 5),
      evidence_refs: db.sessions.slice(-3).map((session) => session.id),
      status: "draft"
    }
  ];
  const payload = {
    generated_at: new Date().toISOString(),
    sample_count: db.sessions.length,
    review_policy: "Claims are draft until the user confirms them. Do not treat low-confidence claims as hard preferences.",
    claims
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Profile Review ==",
    `samples=${payload.sample_count}`,
    payload.review_policy,
    ...claims.map((claim, index) => `${index + 1}. [${claim.dimension}] ${claim.claim}\nconfidence=${claim.confidence}\nevidence=${claim.evidence_refs.join(", ") || "(none)"}`)
  ].join("\n");
}

function readTaskText(options?: { task?: string; taskFile?: string }): string {
  if (options?.taskFile) return fs.readFileSync(options.taskFile, "utf8").trim();
  return options?.task?.trim() ?? "";
}

function pendingGitFiles(cwd = process.cwd()): string[] {
  try {
    const out = execSync("git status --porcelain", { cwd, stdio: "pipe" }).toString();
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .map((file) => file.split(" -> ").at(-1)?.trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function briefCommand(options?: {
  task?: string;
  taskFile?: string;
  format?: "markdown" | "json";
  profile?: "compact" | "full" | "strict";
}): string {
  const storage = new JsonStorage();
  const task = readTaskText(options) || defaultTaskSummary(storage);
  const profile = options?.profile ?? "compact";
  const context = storage.buildAgentContext(task);
  const payload = {
    task_summary: context.task_summary,
    profile,
    sample_count: context.data_quality.sample_count,
    confidence: context.data_quality.confidence,
    user_style: context.user_style,
    relevant_domains: context.relevant_domains,
    relevant_workflows: profile === "compact" ? context.relevant_workflows.slice(0, 2) : context.relevant_workflows,
    recommended_agent_behavior: context.recommended_agent_behavior,
    safety_policy: context.safety_policy,
    warnings: context.data_quality.warnings
  };
  if (options?.format === "json") return JSON.stringify(payload, null, 2);
  const strictLines = profile === "strict"
    ? [
        "- Treat safety_policy as hard requirements.",
        "- Do not invent user preferences beyond evidence.",
        "- Before writing files, run `nms guard --files ...`."
      ]
    : [];
  return [
    "# NMS Agent Brief",
    "",
    `Task: ${payload.task_summary}`,
    `Samples: ${payload.sample_count}`,
    `Confidence: ${payload.confidence}`,
    "",
    "## User Style",
    `- Communication: ${payload.user_style.communication.join(", ")}`,
    `- Workflow preference: ${payload.user_style.workflow.join(", ")}`,
    `- Avoid: ${payload.user_style.avoid.join(", ")}`,
    "",
    "## Relevant Domains",
    ...(payload.relevant_domains.length > 0
      ? payload.relevant_domains.map((domain) => `- ${domain.name}: ${domain.count} samples, confidence ${domain.confidence}`)
      : ["- none yet"]),
    "",
    "## Relevant Workflows",
    ...(payload.relevant_workflows.length > 0
      ? payload.relevant_workflows.map((workflow) => `- ${workflow.name} (${workflow.confidence})`)
      : ["- none yet"]),
    "",
    "## Agent Rules",
    ...payload.recommended_agent_behavior.map((item) => `- ${item}`),
    ...strictLines,
    "",
    "## Warnings",
    ...(payload.warnings.length > 0 ? payload.warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}

export function suggestCommand(options?: {
  task?: string;
  taskFile?: string;
  format?: "human" | "json";
}): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const packs = storage.loadDomainPacks();
  const task = readTaskText(options) || defaultTaskSummary(storage);
  const domainGuess = detectDomainFromText(task, packs);
  const pack = domainPackFor(domainGuess.domain, packs);
  const historicalWorkflow = Object.entries(db.stats.workflow_counts)
    .map(([workflow, count]) => ({ workflow, count, steps: workflow.split(" -> ") }))
    .filter((item) => item.steps.some((step) => Object.values(pack.skills).flat().includes(step)))
    .sort((a, b) => b.count - a.count)[0];
  const template = pack.workflow_templates[0] ?? [];
  const steps = historicalWorkflow?.steps.length ? historicalWorkflow.steps : template;
  const payload = {
    task_summary: task || "(not provided)",
    detected_domain: domainGuess.domain,
    domain_confidence: domainGuess.confidence,
    source: historicalWorkflow ? "history" : "domain_template",
    suggested_workflow: steps,
    why: historicalWorkflow
      ? `Matched historical workflow used ${historicalWorkflow.count} time(s).`
      : `No stable history for this task; using ${pack.domain} domain template.`,
    next_commands: [
      `nms brief --task "${task || "your task"}" --profile strict`,
      "nms guard --files sandbox/new/example.tsx",
      "nms night --dry-run --explain --task-file task.json"
    ]
  };
  if (options?.format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Suggest ==",
    `task=${payload.task_summary}`,
    `domain=${payload.detected_domain} (${payload.domain_confidence})`,
    `source=${payload.source}`,
    `workflow=${payload.suggested_workflow.join(" -> ") || "(none)"}`,
    `why=${payload.why}`,
    "next:",
    ...payload.next_commands.map((command) => `- ${command}`)
  ].join("\n");
}

export function guardCommand(files: string[], format: "human" | "json" = "human"): string {
  const guard = files.length === 0
    ? { ok: false, reason: "No files provided for write-scope check." }
    : validateWriteScope(files, DEFAULT_CONFIG);
  const payload = {
    ok: guard.ok,
    files,
    reason: guard.reason ?? "All files are inside allowed roots and file types.",
    policy: {
      allowed_roots: DEFAULT_CONFIG.harness.allowed_roots,
      core_explicit_whitelist: DEFAULT_CONFIG.harness.core_explicit_whitelist,
      allowed_file_kinds: ["ui", "new", "test"]
    }
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Guard ==",
    `decision=${payload.ok ? "ALLOW" : "BLOCK"}`,
    `reason=${payload.reason}`,
    `files=${files.join(", ") || "(none)"}`,
    `allowed_roots=${payload.policy.allowed_roots.join(", ")}`
  ].join("\n");
}

export function guardPendingCommand(format: "human" | "json" = "human"): string {
  const files = pendingGitFiles();
  if (files.length === 0) {
    const payload = {
      ok: true,
      files,
      reason: "No pending git files detected. Nothing needs write-scope approval right now.",
      policy: {
        allowed_roots: DEFAULT_CONFIG.harness.allowed_roots,
        core_explicit_whitelist: DEFAULT_CONFIG.harness.core_explicit_whitelist,
        allowed_file_kinds: ["ui", "new", "test"]
      }
    };
    if (format === "json") return JSON.stringify(payload, null, 2);
    return [
      "== NMS Guard ==",
      "decision=ALLOW",
      `reason=${payload.reason}`,
      "files=(none)",
      `allowed_roots=${payload.policy.allowed_roots.join(", ")}`
    ].join("\n");
  }
  return guardCommand(files, format);
}

type DataStatusPayload = {
  sample_count: number;
  latest_session_at: string | null;
  domain_coverage: Array<{ name: string; count: number }>;
  top_skills: Array<[string, number]>;
  top_workflows: Array<[string, number]>;
  quality: Stats["quality_metrics"];
  warnings: string[];
};

type BriefPayload = {
  task_summary: string;
  sample_count: number;
  confidence: number;
  user_style: AgentContext["user_style"];
  warnings: string[];
};

type SuggestPayload = {
  detected_domain: string;
  domain_confidence: number;
  source: string;
  suggested_workflow: string[];
  why: string;
};

type GuardPayload = {
  ok: boolean;
  files: string[];
  reason: string;
};

function decisionFromAuto(guard: GuardPayload, night: NightReport | null): "READY_FOR_REVIEW" | "BLOCKED_BY_POLICY" | "NEEDS_ATTENTION" {
  if (!guard.ok) return "BLOCKED_BY_POLICY";
  if (night?.final_state === State.GATE || night?.final_state === State.COMMIT) return "READY_FOR_REVIEW";
  return "NEEDS_ATTENTION";
}

export function autoCommand(format: "human" | "json" = "human"): string {
  const storage = new JsonStorage();
  const task = defaultTaskSummary(storage);
  const data = JSON.parse(dataStatusCommand("json")) as {
    sample_count: number;
    latest_session_at: string | null;
    domain_coverage: Array<{ name: string; count: number }>;
    top_skills: Array<[string, number]>;
    top_workflows: Array<[string, number]>;
    quality: Stats["quality_metrics"];
    warnings: string[];
  } satisfies DataStatusPayload;
  const context = JSON.parse(contextCommand({ task, format: "json" })) as AgentContext;
  const brief = JSON.parse(briefCommand({ task, profile: "strict", format: "json" })) as BriefPayload;
  const suggestion = JSON.parse(suggestCommand({ task, format: "json" })) as SuggestPayload;
  const guard = JSON.parse(guardPendingCommand("json")) as GuardPayload;
  const night = guard.ok
    ? JSON.parse(nightCommand({ dryRun: true, explain: true, task })) as NightReport
    : null;
  const decision = decisionFromAuto(guard, night);
  const gateReason = !guard.ok
    ? guard.reason
    : night?.failure?.failure_reason ?? night?.explain_chain?.at(-1) ?? "Dry-run gate reached review-ready state.";
  const workflow = suggestion.suggested_workflow.length > 0
    ? suggestion.suggested_workflow
    : context.relevant_workflows[0]?.steps ?? [];
  const workflowText = workflow.length > 0 ? workflow.join(" -> ") : "(no stable workflow yet)";
  const birthdayMemory = context.birthday_memory;
  const nextStep = decision === "READY_FOR_REVIEW"
    ? "Review the generated dry-run plan. Use an explicit reviewed task-file before any apply."
    : decision === "BLOCKED_BY_POLICY"
      ? "Resolve or move pending files into the allowed sandbox/feature scope, then run /nms-auto again."
      : "Fix the reported policy/test/review issue, then run /nms-auto again.";
  const agentWorkflow = [
    {
      stage: "READ_BEHAVIOR_MEMORY",
      status: "done",
      summary: birthdayMemory
        ? `${context.data_quality.sample_count} real sample(s), confidence ${context.data_quality.confidence}; birthday north star=${birthdayMemory.north_star}.`
        : `${context.data_quality.sample_count} real sample(s), confidence ${context.data_quality.confidence}.`
    },
    {
      stage: "BUILD_USER_BRIEF",
      status: "done",
      summary: `Style=${brief.user_style.communication.join(", ") || "unknown"}; avoid=${brief.user_style.avoid.join(", ") || "none"}.`
    },
    {
      stage: "SELECT_WORKFLOW",
      status: "done",
      summary: `${suggestion.source}; ${workflowText}.`
    },
    {
      stage: "CHECK_WRITE_BOUNDARY",
      status: guard.ok ? "pass" : "block",
      summary: guard.reason
    },
    {
      stage: "RUN_DRY_GATE",
      status: guard.ok ? (night?.final_state === State.GATE ? "pass" : "attention") : "skipped",
      summary: guard.ok ? gateReason : "Skipped because write boundary failed before execution."
    }
  ];
  const payload = {
    mode: "dry-run",
    entry: "/nms-auto",
    hidden_internal_commands: true,
    decision,
    task_summary: task,
    data_quality: {
      sample_count: data.sample_count,
      latest_session_at: data.latest_session_at,
      behavior_score: data.quality.behavior_score,
      workflow_confidence: data.quality.workflow_confidence,
      stale_risk: data.quality.stale_risk,
      warnings: data.warnings
    },
    user_profile_summary: {
      communication: brief.user_style.communication,
      workflow_preference: brief.user_style.workflow,
      avoid: brief.user_style.avoid
    },
    birthday_memory: birthdayMemory ?? null,
    selected_workflow: {
      domain: suggestion.detected_domain,
      confidence: suggestion.domain_confidence,
      source: suggestion.source,
      steps: workflow,
      why: suggestion.why
    },
    write_guard: {
      ok: guard.ok,
      files_checked: guard.files,
      reason: guard.reason
    },
    gate: {
      ran: Boolean(night),
      final_state: night?.final_state ?? State.ROLLBACK,
      dry_run: night?.dry_run ?? true,
      explain_chain: night?.explain_chain ?? [],
      failure: night?.failure ?? (!guard.ok
        ? {
            code: "POLICY_BLOCK",
            failure_reason: guard.reason,
            recovery_hint: "Resolve pending files outside the allowed write scope before auto execution.",
            retry_count: 0,
            non_retryable: true,
            state_at_failure: State.PLAN,
            artifacts_ref: "write-guard"
          }
        : null)
    },
    agent_workflow: agentWorkflow,
    next_step: nextStep
  };

  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Auto ==",
    "Mode: hidden-agent workflow, dry-run only",
    `Decision: ${payload.decision}`,
    `Task: ${payload.task_summary}`,
    `Samples: ${payload.data_quality.sample_count}`,
    `Behavior Score: ${payload.data_quality.behavior_score}`,
    `Workflow Confidence: ${payload.data_quality.workflow_confidence}`,
    ...(birthdayMemory ? [`Birthday North Star: ${birthdayMemory.north_star}`] : []),
    `Selected Workflow: ${workflowText}`,
    "== Agent Workflow ==",
    ...agentWorkflow.map((step, index) => `${index + 1}. ${step.stage}: ${step.status}\n   ${step.summary}`),
    "== Safety Gate ==",
    `write_boundary=${payload.write_guard.ok ? "ALLOW" : "BLOCK"}`,
    `gate_ran=${payload.gate.ran}`,
    `final_state=${payload.gate.final_state}`,
    `why=${gateReason}`,
    `Next: ${payload.next_step}`
  ].join("\n");
}

export function flowVisualCommand(): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const domainEntries = Object.entries(db.stats.domain_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const topSkills = Object.entries(db.stats.skill_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topWorkflow = Object.entries(db.stats.workflow_counts)
    .sort((a, b) => b[1] - a[1])[0]?.[0]
    ?.split(" -> ") ?? [];
  const edgeEntries = workflowEdgeCounts(db.sessions).slice(0, 6);
  const quality = db.stats.quality_metrics;
  const maxSkill = Math.max(1, ...topSkills.map(([, count]) => count));
  const maxDomain = Math.max(1, ...domainEntries.map(([, count]) => count));
  const html = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NMS Flow Dashboard</title>
  <style>
    :root { --bg:#080a12; --panel:rgba(15,23,42,.82); --line:rgba(148,163,184,.24); --text:#eef2ff; --muted:#94a3b8; --cyan:#22d3ee; --green:#34d399; --amber:#fbbf24; }
    * { box-sizing: border-box; }
    body { font-family: "Aptos Display", "Segoe UI", "PingFang SC", sans-serif; margin: 0; background: radial-gradient(circle at 10% 0%, rgba(34,211,238,.24), transparent 30%), radial-gradient(circle at 86% 8%, rgba(251,191,36,.16), transparent 26%), var(--bg); color: var(--text); }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 42px 22px; }
    .hero,.card { background: var(--panel); border: 1px solid var(--line); border-radius: 28px; padding: 24px; margin-bottom: 18px; box-shadow: 0 18px 70px rgba(0,0,0,.28); }
    .eyebrow { color: var(--cyan); text-transform: uppercase; letter-spacing: .15em; font-size: 12px; }
    .title { font-size: clamp(34px,5vw,66px); line-height:.95; margin: 12px 0; max-width: 900px; font-weight: 850; }
    .subtitle { color: var(--muted); font-size: 16px; line-height: 1.7; }
    .grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; }
    .two { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .kpi { background: rgba(30,41,59,0.72); border: 1px solid rgba(148,163,184,.14); border-radius: 18px; padding: 15px; }
    .kpi .v { font-size: 32px; font-weight: 800; margin-top: 8px; }
    .bar { height: 12px; background: rgba(148,163,184,.16); border-radius: 999px; overflow: hidden; margin-top: 8px; }
    .bar > div { height: 100%; background: linear-gradient(90deg,var(--cyan),var(--green)); }
    .row { margin: 14px 0; }
    .label { display:flex; justify-content:space-between; gap:12px; font-size:14px; color:#dbeafe; }
    .path { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .node { border:1px solid rgba(34,211,238,.34); background:rgba(34,211,238,.12); color:#cffafe; padding:9px 12px; border-radius:999px; }
    .arrow { color: var(--amber); }
    code { background: #0b1220; padding: 2px 6px; border-radius: 6px; color: #93c5fd; }
    @media (max-width: 860px) { .grid,.two { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 560px) { .grid,.two { grid-template-columns: 1fr; } .wrap { padding: 20px 12px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="eyebrow">No More Skill · NMS 行为驾驶舱 · live behavior cockpit</div>
      <div class="title">你的 Agent 工作方式，正在被真实数据驯化。</div>
      <p class="subtitle">本页面读取本地 <code>.nms</code> 真实行为数据，展示领域分布、技能频率、主 workflow 和系统健康度。</p>
      <div class="grid">
        <div class="kpi"><div>Behavior Score</div><div class="v">${quality.behavior_score}</div></div>
        <div class="kpi"><div>Workflow Confidence</div><div class="v">${Math.round(
          quality.workflow_confidence * 100
        )}%</div></div>
        <div class="kpi"><div>Session Velocity(7d)</div><div class="v">${quality.session_velocity_7d}</div></div>
        <div class="kpi"><div>Streak Days</div><div class="v">${quality.streak_days}</div></div>
      </div>
    </div>
    <div class="two">
      <div class="card">
        <h3>Domain Mix</h3>
        ${
          domainEntries.length > 0
            ? domainEntries
                .map(
                  ([name, count]) => `<div class="row"><div class="label"><span>${escapeHtml(name)}</span><span>${count}</span></div><div class="bar"><div style="width:${Math.max(6, Math.round((count / maxDomain) * 100))}%"></div></div></div>`
                )
                .join("")
            : `<p class="subtitle">暂无领域数据。</p>`
        }
      </div>
      <div class="card">
        <h3>Top Skills</h3>
        ${
          topSkills.length > 0
            ? topSkills
                .map(
                  ([name, count]) => `<div class="row"><div class="label"><span>${escapeHtml(name)}</span><span>${count}</span></div><div class="bar"><div style="width:${Math.max(6, Math.round((count / maxSkill) * 100))}%"></div></div></div>`
                )
                .join("")
            : `<p class="subtitle">暂无技能频率数据。</p>`
        }
      </div>
    </div>
    <div class="card">
      <h3>Main Workflow Path</h3>
      <div class="path">
        ${
          topWorkflow.length > 0
            ? topWorkflow.map((step, idx) => `${idx > 0 ? `<span class="arrow">→</span>` : ""}<span class="node">${escapeHtml(step)}</span>`).join("")
            : `<span class="subtitle">暂无稳定 workflow。</span>`
        }
      </div>
    </div>
    <div class="card">
      <h3>Top Workflow Edges</h3>
      ${
        edgeEntries.length > 0
          ? edgeEntries
              .map((edge) => `<div class="row"><div class="label"><span>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span><span>${edge.count}</span></div></div>`)
              .join("")
          : `<p class="subtitle">暂无 workflow 边数据。</p>`
      }
      <p class="subtitle">Use <code>nms flow --format json</code> for raw machine-readable data.</p>
    </div>
  </div>
</body>
</html>`;

  const outDir = path.join(process.cwd(), ".nms");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "flow-dashboard.html");
  fs.writeFileSync(outPath, html, "utf8");
  return outPath;
}

export function replayCommand(): string {
  const storage = new JsonStorage();
  const wf = storage.mostCommonWorkflow();
  if (wf.length === 0) return "暂无可复现 workflow，请先 ingest。";
  return `Replaying workflow:\n${wf.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
}

export function nightCommand(options: {
  dryRun?: boolean;
  apply?: boolean;
  timeBudget?: number;
  explain?: boolean;
  taskFile?: string;
  task?: string;
  resume?: string;
}): string {
  if (options.resume) return resumeNightRunCommand(options.resume);
  const started = performance.now();
  const apply = Boolean(options.apply);
  const dryRun = apply ? Boolean(options.dryRun) : options.dryRun ?? true;
  if (apply && options.task && !options.taskFile) {
    return JSON.stringify(
      {
        dry_run: false,
        final_state: State.ROLLBACK,
        retries: 0,
        logs: ["Auto-planned --task is dry-run only. Provide --task-file for apply."],
        failure: {
          code: "CONFIG_ERROR",
          failure_reason: "Apply requires explicit task-file",
          recovery_hint: "Run dry-run first, then create a reviewed task-file for --apply.",
          retry_count: 0,
          non_retryable: true,
          state_at_failure: State.PLAN,
          artifacts_ref: "task"
        }
      },
      null,
      2
    );
  }
  const storage = new JsonStorage();
  const autoTask = options.task ?? (!options.taskFile && !apply ? defaultTaskSummary(storage) : undefined);
  const plannerInput = options.taskFile
    ? readPlannerInput(options.taskFile)
    : autoTask
      ? buildPlannerFromTask(autoTask, storage)
      : undefined;
  const report = runNightHarness({
    dryRun,
    apply,
    explain: Boolean(options.explain),
    plannerInput,
    timeBudgetMinutes: options.timeBudget ?? 5
  });
  if (autoTask && !options.taskFile) {
    report.logs.push("Auto planner generated from route defaults or --task. Review and persist a task-file before apply.");
  }
  storage.trackPerf("night_ms", Number((performance.now() - started).toFixed(2)));
  storage.recordNightRun(report);
  return JSON.stringify(report, null, 2);
}

function buildPlannerFromTask(task: string, storage: JsonStorage): PlannerOutput {
  const packs = storage.loadDomainPacks();
  const domainGuess = detectDomainFromText(task, packs);
  const pack = domainPackFor(domainGuess.domain, packs);
  const workflow = pack.workflow_templates[0] ?? [];
  return {
    task,
    files: ["sandbox/new/nms-night-plan.md"],
    constraints: [
      "auto-planned dry-run only",
      "do not apply without an explicit reviewed task-file",
      `detected_domain=${domainGuess.domain}`,
      `suggested_workflow=${workflow.join(" -> ") || "none"}`
    ],
    test_plan: ["node -e \"process.exit(0)\""]
  };
}

function resumeNightRunCommand(resumeId: string): string {
  const storage = new JsonStorage();
  const runDir = path.join(storage.root, "artifacts", "night-runs");
  const files = fs.existsSync(runDir)
    ? fs.readdirSync(runDir).filter((entry) => entry.endsWith(".json"))
    : [];
  const match = files.find((file) => file.includes(resumeId)) ?? files.sort().at(-1);
  if (!match) {
    return JSON.stringify(
      {
        resumed: false,
        resume_id: resumeId,
        recovery_hint: "No night-run artifact found. Run nms night --dry-run --task-file task.json first."
      },
      null,
      2
    );
  }
  const fullPath = path.join(runDir, match);
  const previous = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return JSON.stringify(
    {
      resumed: true,
      resume_id: resumeId,
      artifact: path.relative(storage.root, fullPath).replaceAll("\\", "/"),
      previous_final_state: previous.final_state,
      previous_failure: previous.failure ?? null,
      next_step: previous.failure
        ? previous.failure.recovery_hint
        : "Previous run did not fail. Use --task-file with --apply only after reviewing the generated plan."
    },
    null,
    2
  );
}

export function doctorCommand(): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const checks: Array<{ check: string; status: "PASS" | "WARN"; detail: string }> = [];

  checks.push({
    check: "Schema Version",
    status: db.schema_version >= 3 ? "PASS" : "WARN",
    detail: `schema_version=${db.schema_version}`
  });
  checks.push({
    check: "Data Integrity",
    status: db.sessions.every((s) => !!s.id && !!s.created_at) ? "PASS" : "WARN",
    detail: `sessions=${db.sessions.length}`
  });
  checks.push({
    check: "Perf Window",
    status: db.stats.perf_windows.max_window >= 50 ? "PASS" : "WARN",
    detail: `window=${db.stats.perf_windows.max_window}`
  });
  const requiredV3Paths = [
    "events",
    "sessions",
    "derived",
    path.join("artifacts", "artifacts.json"),
    path.join("policies", "safety.json"),
    path.join("domains", "coding.json")
  ];
  for (const rel of requiredV3Paths) {
    const full = path.join(storage.root, rel);
    checks.push({
      check: `V3 ${rel.replaceAll("\\", "/")}`,
      status: fs.existsSync(full) ? "PASS" : "WARN",
      detail: fs.existsSync(full) ? "present" : "missing"
    });
  }

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: "pipe" }).toString().trim();
    checks.push({
      check: "Git Safety",
      status: branch === "main" ? "WARN" : "PASS",
      detail: `current_branch=${branch}`
    });
  } catch {
    checks.push({
      check: "Git Safety",
      status: "WARN",
      detail: "not a git repository"
    });
  }

  const lines = ["== NMS Doctor ==", ...checks.map((c) => `[${c.status}] ${c.check}: ${c.detail}`)];
  return lines.join("\n");
}

async function saveImageFromResponse(
  payload: any,
  outputPath: string
): Promise<"written" | "unsupported"> {
  const candidate =
    payload?.data?.[0]?.b64_json ??
    payload?.data?.[0]?.base64 ??
    payload?.b64_json ??
    payload?.base64 ??
    null;
  if (candidate && typeof candidate === "string") {
    fs.writeFileSync(outputPath, Buffer.from(candidate, "base64"));
    return "written";
  }
  const imageUrl =
    payload?.data?.[0]?.url ??
    payload?.data?.[0]?.image_url ??
    payload?.url ??
    null;
  if (imageUrl && typeof imageUrl === "string") {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`Failed to download image URL: ${resp.status}`);
    const arr = await resp.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arr));
    return "written";
  }
  return "unsupported";
}

async function generateImageViaRelay(options: {
  prompt: string;
  outputPath: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<void> {
  const baseUrl = options.baseUrl ?? process.env.NMS_IMAGE_BASE_URL;
  const apiKey = options.apiKey ?? process.env.NMS_IMAGE_API_KEY;
  const model = options.model ?? process.env.NMS_IMAGE_MODEL ?? "gpt-image-2";
  if (!baseUrl || !apiKey) {
    throw new Error("Missing image relay config. Set NMS_IMAGE_BASE_URL and NMS_IMAGE_API_KEY.");
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      n: 1,
      size: "16:9",
      resolution: "2k"
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Image relay error ${response.status}: ${text}`);
  }
  const payload = await response.json();

  const immediateResult = await saveImageFromResponse(payload, options.outputPath);
  if (immediateResult === "written") return;

  const taskId: string | undefined = payload?.data?.[0]?.task_id ?? payload?.data?.task_id;
  if (!taskId) {
    throw new Error("Relay response missing task_id and direct image data.");
  }

  const base = new URL(baseUrl);
  const taskUrl = `${base.origin}/v1/tasks/${taskId}?language=en`;

  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const taskResp = await fetch(taskUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    if (!taskResp.ok) continue;
    const taskPayload = await taskResp.json();
    const status: string | undefined = taskPayload?.data?.status;
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Image task failed: ${JSON.stringify(taskPayload)}`);
    }
    if (status !== "completed") continue;

    const images = taskPayload?.data?.result?.images;
    const imageUrl =
      images?.[0]?.url?.[0] ??
      images?.[0]?.url ??
      taskPayload?.data?.result?.url ??
      null;
    if (!imageUrl || typeof imageUrl !== "string") {
      throw new Error("Task completed but no image URL found.");
    }
    const download = await fetch(imageUrl);
    if (!download.ok) throw new Error(`Failed to download generated image: ${download.status}`);
    const arr = await download.arrayBuffer();
    fs.writeFileSync(options.outputPath, Buffer.from(arr));
    return;
  }
  throw new Error("Image task polling timeout.");
}

export async function reportCommand(options?: {
  image?: boolean;
  outputDir?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  format?: "md" | "html" | "json";
  period?: string;
  template?: string;
  realOnly?: boolean;
}): Promise<string> {
  const storage = new JsonStorage();
  const db = storage.load();
  const packs = storage.loadDomainPacks();
  const period = options?.period ?? "7d";
  const template = normalizeReportTemplate(options?.template);
  const templateCopy = reportTemplateCopy(template);
  const sessionsWithDomains = db.sessions.map((session) => ({
    ...session,
    domain: detectSessionDomain(session, packs)
  }));
  const reportSessions = filterSessionsByPeriod(sessionsWithDomains, period);
  const counts = sessionCounts(reportSessions);
  const reportDir = options?.outputDir
    ? path.resolve(options.outputDir)
    : path.join(storage.root, "artifacts", "reports", "latest");
  const assetDir = path.join(reportDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });

  const topSkills = Object.entries(counts.skillCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topWorkflows = Object.entries(counts.workflowCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topDomains = Object.entries(counts.domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const workflowEdges = workflowEdgeCounts(reportSessions).slice(0, 8);
  const quality = reportQualityMetrics(reportSessions, counts.workflowCounts);
  const sourceHash = sha256(JSON.stringify({ sessions: reportSessions.length, period, template, topSkills, topWorkflows, topDomains, workflowEdges, quality }));

  const progressSummary = [
    `周期内会话数: ${reportSessions.length}`,
    `主工作流置信度: ${quality.workflow_confidence}`,
    `7日活跃度: ${quality.session_velocity_7d}`,
    `连续天数: ${quality.streak_days}`,
    `陈旧风险: ${quality.stale_risk}%`
  ].join("；");

  const realDataNotice =
    reportSessions.length === 0
      ? "真实样本不足：必须在画面中标注“样本不足”，不得补充虚构技能、频率、workflow 或趋势。"
      : `所有指标必须只使用这些真实数据，周期=${period}，样本数=${reportSessions.length}，不得虚构额外指标。`;

  const skillPrompt = `${realDataNotice} 制作专业信息图：展示NMS技能使用频率。数据：${topSkills
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}。领域分布：${topDomains.map(([k, v]) => `${k}:${v}`).join(", ")}。风格：深色科技、清晰标签、中文标题“技能使用频率”。`;
  const progressPrompt = `${realDataNotice} 制作项目进展图：${progressSummary}。包含workflow排名：${topWorkflows
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}。包含workflow边：${workflowEdges.map((edge) => `${edge.from}->${edge.to}:${edge.count}`).join(", ")}。风格：产品周报图表、专业、简洁。`;
  const personaPrompt = `${realDataNotice} 制作人格演化图：style=${db.user_profile.style}，top_skills=${db.user_profile.top_skills.join(
    ","
  )}，top_workflows=${db.user_profile.top_workflows.join(
    ","
  )}，behavior_score=${quality.behavior_score}。风格：成长路径可视化、专业温暖。`;

  const skillImg = path.join(assetDir, "skill-frequency.png");
  const progressImg = path.join(assetDir, "work-progress.png");
  const personaImg = path.join(assetDir, "persona-evolution.png");
  const artifactImageDir = path.join(storage.root, "artifacts", "images");
  const artifactPromptDir = path.join(storage.root, "artifacts", "prompts");
  fs.mkdirSync(artifactImageDir, { recursive: true });
  fs.mkdirSync(artifactPromptDir, { recursive: true });

  const imageNotes: string[] = [];
  if (options?.image) {
    for (const [slug, prompt] of [
      ["skill-frequency", skillPrompt],
      ["work-progress", progressPrompt],
      ["persona-evolution", personaPrompt]
    ] as const) {
      const promptPath = path.join(artifactPromptDir, `${slug}-${Date.now()}.md`);
      fs.writeFileSync(promptPath, prompt, "utf8");
      storage.recordArtifact({
        type: "prompt",
        path: path.relative(storage.root, promptPath).replaceAll("\\", "/"),
        source_data_hash: sourceHash,
        real_data_only: options.realOnly ?? true,
        metadata: { slug, period }
      });
    }
    await Promise.all([
      generateImageViaRelay({
        prompt: skillPrompt,
        outputPath: path.join(artifactImageDir, "skill-frequency.png"),
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model
      }),
      generateImageViaRelay({
        prompt: progressPrompt,
        outputPath: path.join(artifactImageDir, "work-progress.png"),
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model
      }),
      generateImageViaRelay({
        prompt: personaPrompt,
        outputPath: path.join(artifactImageDir, "persona-evolution.png"),
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model
      })
    ]);
    for (const name of ["skill-frequency.png", "work-progress.png", "persona-evolution.png"]) {
      const artifactPath = path.join(artifactImageDir, name);
      const reportCopy = path.join(assetDir, name);
      fs.copyFileSync(artifactPath, reportCopy);
      storage.recordArtifact({
        type: "image",
        path: path.relative(storage.root, artifactPath).replaceAll("\\", "/"),
        source_data_hash: sourceHash,
        real_data_only: options.realOnly ?? true,
        metadata: { name, model: options.model ?? process.env.NMS_IMAGE_MODEL ?? "gpt-image-2" }
      });
    }
    imageNotes.push("三张可视化图片已通过中转站生成。");
  } else {
    imageNotes.push("未启用 --image，仅生成文本报告。");
  }

  const reportPayload = {
    generated_at: new Date().toISOString(),
    period,
    template,
    real_only: options?.realOnly ?? true,
    sample_count: reportSessions.length,
    top_skills: topSkills,
    top_workflows: topWorkflows,
    top_domains: topDomains,
    workflow_edges: workflowEdges,
    quality,
    user_profile: db.user_profile,
    image_notes: imageNotes
  };

  if (options?.format === "json") {
    const reportPath = path.join(reportDir, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify(reportPayload, null, 2), "utf8");
    storage.recordArtifact({
      type: "report",
      path: path.relative(storage.root, reportPath).replaceAll("\\", "/"),
      source_data_hash: sourceHash,
      real_data_only: options.realOnly ?? true,
      metadata: { format: "json", period, template }
    });
    storage.recordEvent("REPORT_GENERATED", path.relative(storage.root, reportPath).replaceAll("\\", "/"), sourceHash);
    return reportPath;
  }

  const reportMd = `# NMS 可视化周报 / NMS Visual Report

更新时间：${new Date().toISOString()}

数据周期：${period}

真实样本数：${reportSessions.length}

${reportSessions.length === 0 ? "> 样本不足：本报告不会编造 skill 频率或 workflow。" : ""}

## 1) Skill 使用频率

${topSkills.map(([k, v], i) => `${i + 1}. ${k}: ${v}`).join("\n") || "(暂无数据)"}

${fs.existsSync(skillImg) ? `![skill-frequency](${path.relative(reportDir, skillImg).replaceAll("\\", "/")})` : ""}

## 2) 领域分布 / Domain Mix

${topDomains.map(([k, v], i) => `${i + 1}. ${k}: ${v}`).join("\n") || "(暂无数据)"}

## 3) 最近工作进展

${progressSummary}

${topWorkflows.map(([k, v], i) => `${i + 1}. ${k} (${v})`).join("\n") || "(暂无数据)"}

Workflow edges:
${workflowEdges.map((edge, i) => `${i + 1}. ${edge.from} -> ${edge.to} (${edge.count})`).join("\n") || "(暂无数据)"}

${fs.existsSync(progressImg) ? `![work-progress](${path.relative(reportDir, progressImg).replaceAll("\\", "/")})` : ""}

## 4) 人格演化 / 风格演化

- 当前风格：${db.user_profile.style}
- Top Skills：${db.user_profile.top_skills.join(", ") || "(暂无)"}
- Top Workflows：${db.user_profile.top_workflows.join(", ") || "(暂无)"}
- Behavior Score：${quality.behavior_score}

${fs.existsSync(personaImg) ? `![persona-evolution](${path.relative(reportDir, personaImg).replaceAll("\\", "/")})` : ""}

## 5) ${templateCopy.mdHeading}

${reportTemplateMarkdown(template, topDomains, topWorkflows)}

## 6) 说明

${imageNotes.map((n) => `- ${n}`).join("\n")}
`;

  if (options?.format === "html") {
    const maxSkill = Math.max(1, ...topSkills.map(([, count]) => count));
    const maxDomain = Math.max(1, ...topDomains.map(([, count]) => count));
    const mainWorkflowSteps = topWorkflows[0]?.[0].split(" -> ") ?? [];
    const html = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NMS Agent Daily Report</title>
  <style>
    :root { color-scheme: dark; --bg:#070911; --panel:rgba(17,24,39,.78); --line:rgba(148,163,184,.24); --text:#eef2ff; --muted:#94a3b8; --cyan:#22d3ee; --green:#34d399; --amber:#fbbf24; --red:#fb7185; --blue:#60a5fa; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Aptos Display", "Segoe UI", "PingFang SC", sans-serif; background: radial-gradient(circle at 8% 4%, rgba(34,211,238,.24), transparent 30%), radial-gradient(circle at 86% 4%, rgba(251,191,36,.14), transparent 28%), linear-gradient(180deg,#090d18,#050711 62%); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 48px 24px; }
    .hero { border: 1px solid var(--line); border-radius: 32px; padding: 36px; background: linear-gradient(145deg, rgba(17,24,39,.94), rgba(15,23,42,.66)); box-shadow: 0 24px 90px rgba(0,0,0,.36); position: relative; overflow: hidden; }
    .hero:after { content:""; position:absolute; width:260px; height:260px; right:-80px; top:-70px; border-radius:50%; background: radial-gradient(circle, rgba(34,211,238,.18), transparent 70%); }
    .eyebrow { color: var(--cyan); letter-spacing: .16em; text-transform: uppercase; font-size: 12px; }
    h1 { font-size: clamp(38px, 6vw, 78px); line-height: .94; margin: 16px 0; max-width: 900px; }
    .subtitle { color: var(--muted); font-size: 18px; line-height: 1.7; max-width: 760px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 22px 0; }
    .two { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card { border: 1px solid var(--line); border-radius: 24px; padding: 22px; background: var(--panel); box-shadow: 0 18px 60px rgba(0,0,0,.22); }
    .metric { font-size: 36px; font-weight: 800; margin-top: 10px; }
    .muted { color: var(--muted); }
    section { margin-top: 22px; }
    h2 { font-size: 24px; margin: 0 0 14px; }
    .bar-row { margin: 16px 0; }
    .bar-label { display: flex; justify-content: space-between; color: #dbeafe; margin-bottom: 8px; }
    .bar { height: 13px; background: rgba(148,163,184,.16); border-radius: 999px; overflow: hidden; }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--green)); border-radius: inherit; }
    .timeline { display: grid; gap: 12px; }
    .step { display:flex; gap: 12px; align-items:flex-start; color:#dbeafe; }
    .dot { width: 28px; height: 28px; border-radius: 50%; display:grid; place-items:center; background: rgba(34,211,238,.16); color: var(--cyan); border:1px solid rgba(34,211,238,.36); flex:0 0 auto; }
    .path { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-top: 12px; }
    .node { border:1px solid rgba(34,211,238,.34); background:rgba(34,211,238,.12); color:#cffafe; padding:9px 12px; border-radius:999px; }
    .arrow { color: var(--amber); }
    .pill { display:inline-block; margin: 4px 6px 4px 0; border:1px solid rgba(96,165,250,.32); color:#bfdbfe; background:rgba(96,165,250,.1); padding:7px 10px; border-radius:999px; }
    .source { font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 14px; margin-top: 18px; }
    .warning { border-color: rgba(251,113,133,.35); background: rgba(127,29,29,.22); color: #fecdd3; }
    img { width: 100%; border-radius: 18px; border: 1px solid var(--line); margin-top: 12px; }
    @media (max-width: 900px) { .grid,.two { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 560px) { .grid,.two { grid-template-columns: 1fr; } main { padding: 24px 14px; } .hero { padding: 22px; } }
  </style>
</head>
<body>
<main>
  <div class="hero">
    <div class="eyebrow">No More Skill · Real Behavior Report</div>
    <h1>你的工作方式，正在变成 Agent 可执行的操作系统。</h1>
    <p class="subtitle">周期：${escapeHtml(period)}。本报告只读取本地 .nms 真实数据，按领域、技能、workflow 和安全建议组织，不补虚构指标。</p>
    <div class="grid">
      <div class="card"><div class="muted">真实样本</div><div class="metric">${reportSessions.length}</div></div>
      <div class="card"><div class="muted">Behavior Score</div><div class="metric">${quality.behavior_score}</div></div>
      <div class="card"><div class="muted">Workflow Confidence</div><div class="metric">${Math.round(quality.workflow_confidence * 100)}%</div></div>
      <div class="card"><div class="muted">Stale Risk</div><div class="metric">${quality.stale_risk}%</div></div>
    </div>
  </div>
  ${reportSessions.length === 0 ? `<section class="card warning"><h2>样本不足 / 数据不足</h2><p>当前周期没有足够真实 session。请先运行 <code>nms ingest --input input.json</code>，再生成报告。</p></section>` : ""}
  <section class="two">
    <div class="card">
      <h2>领域分布</h2>
      ${
        topDomains.length > 0
          ? topDomains
              .map(
                ([name, count]) => `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(name)}</span><span>${count}</span></div><div class="bar"><span style="width:${Math.max(6, Math.round((count / maxDomain) * 100))}%"></span></div></div>`
              )
              .join("")
          : `<p class="muted">暂无领域数据。</p>`
      }
    </div>
    <div class="card">
      <h2>Skill 使用频率</h2>
      ${
        topSkills.length > 0
          ? topSkills
              .map(
                ([name, count]) => `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(name)}</span><span>${count}</span></div><div class="bar"><span style="width:${Math.max(6, Math.round((count / maxSkill) * 100))}%"></span></div></div>`
              )
              .join("")
          : `<p class="muted">暂无 skill 频率数据。</p>`
      }
      ${fs.existsSync(skillImg) ? `<img src="${path.relative(reportDir, skillImg).replaceAll("\\", "/")}" alt="skill frequency" />` : ""}
    </div>
  </section>
  <section class="card">
    <h2>主 Workflow 路径</h2>
    <div class="path">
      ${
        mainWorkflowSteps.length > 0
          ? mainWorkflowSteps.map((step, index) => `${index > 0 ? `<span class="arrow">→</span>` : ""}<span class="node">${escapeHtml(step)}</span>`).join("")
          : `<p class="muted">暂无主 workflow。</p>`
      }
    </div>
  </section>
  <section class="card">
    <h2>Workflow 排名与转移边</h2>
    <div class="timeline">
      ${
        topWorkflows.length > 0
          ? topWorkflows
              .map(([wf, count], index) => `<div class="step"><div class="dot">${index + 1}</div><div><strong>${escapeHtml(wf)}</strong><div class="muted">出现 ${count} 次</div></div></div>`)
              .join("")
          : `<p class="muted">暂无可稳定复现的 workflow。</p>`
      }
    </div>
    <div style="margin-top:14px">
      ${
        workflowEdges.length > 0
          ? workflowEdges.map((edge) => `<span class="pill">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)} · ${edge.count}</span>`).join("")
          : `<p class="muted">暂无 workflow 转移边。</p>`
      }
    </div>
    ${fs.existsSync(progressImg) ? `<img src="${path.relative(reportDir, progressImg).replaceAll("\\", "/")}" alt="work progress" />` : ""}
  </section>
  <section class="card">
    <h2>用户风格与人格演化</h2>
    <p>当前风格：<strong>${escapeHtml(db.user_profile.style)}</strong></p>
    <p class="muted">Top Skills：${db.user_profile.top_skills.map(escapeHtml).join(", ") || "暂无"}</p>
    <p class="muted">Top Workflows：${db.user_profile.top_workflows.map(escapeHtml).join(", ") || "暂无"}</p>
    ${fs.existsSync(personaImg) ? `<img src="${path.relative(reportDir, personaImg).replaceAll("\\", "/")}" alt="persona evolution" />` : ""}
  </section>
  ${reportTemplateHtml(template, topDomains, topWorkflows)}
  <section class="card">
    <h2>下一步建议</h2>
    <div class="step"><div class="dot">1</div><div><strong>继续采集真实工作流</strong><div class="muted">next: nms ingest --input input.json</div></div></div>
    <div class="step"><div class="dot">2</div><div><strong>给 Agent 读取上下文</strong><div class="muted">next: nms context --task "你的任务" --format json</div></div></div>
    <div class="step"><div class="dot">3</div><div><strong>先 dry-run 再执行</strong><div class="muted">next: nms night --dry-run --explain --task-file task.json</div></div></div>
    <div class="source">数据来源：.nms/sessions + .nms/derived；报告产物已登记到 .nms/artifacts/artifacts.json。</div>
  </section>
</main>
</body>
</html>`;
    const reportPath = path.join(reportDir, "report.html");
    fs.writeFileSync(reportPath, html, "utf8");
    storage.recordArtifact({
      type: "report",
      path: path.relative(storage.root, reportPath).replaceAll("\\", "/"),
      source_data_hash: sourceHash,
      real_data_only: options.realOnly ?? true,
      metadata: { format: "html", period, template }
    });
    storage.recordEvent("REPORT_GENERATED", path.relative(storage.root, reportPath).replaceAll("\\", "/"), sourceHash);
    return reportPath;
  }

  const reportPath = path.join(reportDir, "report.md");
  fs.writeFileSync(reportPath, reportMd, "utf8");
  storage.recordArtifact({
    type: "report",
    path: path.relative(storage.root, reportPath).replaceAll("\\", "/"),
    source_data_hash: sourceHash,
    real_data_only: options?.realOnly ?? true,
    metadata: { format: "md", period, template }
  });
  storage.recordEvent("REPORT_GENERATED", path.relative(storage.root, reportPath).replaceAll("\\", "/"), sourceHash);
  return reportPath;
}

export async function birthdayCommand(options?: {
  image?: boolean;
  outputDir?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  format?: "human" | "json";
  periodDays?: number;
}): Promise<string> {
  const storage = new JsonStorage();
  const db = storage.load();
  const packs = storage.loadDomainPacks();
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const periodDays = options?.periodDays ?? 365;
  const sessionsWithDomains = db.sessions.map((session) => ({
    ...session,
    domain: detectSessionDomain(session, packs)
  }));
  const currentSessions = sessionsWithinDays(sessionsWithDomains, periodDays);
  const previousSessions = sessionsWithinDays(sessionsWithDomains, periodDays, periodDays);
  const currentCounts = sessionCounts(currentSessions);
  const previousCounts = sessionCounts(previousSessions);
  const currentQuality = reportQualityMetrics(currentSessions, currentCounts.workflowCounts);
  const previousQuality = reportQualityMetrics(previousSessions, previousCounts.workflowCounts);
  const topSkills = topEntries(currentCounts.skillCounts, 8);
  const previousSkillNames = new Set(Object.keys(previousCounts.skillCounts));
  const emergingSkills = topSkills
    .filter(([name, count]) => !previousSkillNames.has(name) || count > (previousCounts.skillCounts[name] ?? 0))
    .slice(0, 5)
    .map(([name]) => name);
  const stableWorkflows = topEntries(currentCounts.workflowCounts, 5).map(([name]) => name);
  const topDomains = topEntries(currentCounts.domainCounts, 4);
  const topDomain = topDomains[0]?.[0];
  const topWorkflow = stableWorkflows[0];
  const northStar = topDomain
    ? `把 ${topDomain} 里的真实工作方式继续沉淀成 Agent 可执行资产。`
    : "先积累真实行为样本，让 Agent 学会你的工作方式，而不是靠猜。";
  const changedHabits = currentSessions.length === 0
    ? ["样本不足：暂不判断习惯变化。"]
    : [
        currentQuality.workflow_confidence >= previousQuality.workflow_confidence
          ? "主 workflow 稳定度正在保持或提升。"
          : "主 workflow 稳定度下降，下一阶段需要减少任务切换。",
        emergingSkills.length > 0
          ? `出现新的高频能力信号：${emergingSkills.join(", ")}。`
          : "暂无新的高频能力信号，继续采集真实使用数据。"
      ];
  const retainedCommitments = [
    "只使用真实 .nms 数据，不编造技能频率、workflow 或人格结论。",
    "继续默认 dry-run + Gate，不跳过测试和审查。",
    topWorkflow ? `保留主 workflow：${topWorkflow}` : "先采集真实 workflow，再做强判断。"
  ];
  const risksToWatch = [
    currentQuality.stale_risk >= 60 ? "行为样本偏陈旧，先补最近真实任务。" : "继续维持近期样本刷新。",
    currentQuality.workflow_confidence < 0.5 ? "workflow 置信度偏低，避免让 Agent 过度拟合。" : "主 workflow 置信度可作为温和偏好使用。",
    "任何生日叙事都不能覆盖安全边界。"
  ];
  const nextYearTargets = [
    topWorkflow ? `把「${topWorkflow}」固化成可复用的 Agent 工作流。` : "先完成 5 次真实 ingest，建立第一条稳定 workflow。",
    emergingSkills[0] ? `围绕「${emergingSkills[0]}」设计 30 天实践闭环。` : "让每次重要任务都留下可复盘的 .nms 行为记录。",
    "让 /nms-auto 默认继承 birthday memory，同时保持显式 apply 边界。"
  ];
  const growthVectors = [
    {
      name: "行为稳定度",
      signal: `${previousQuality.behavior_score} -> ${currentQuality.behavior_score}`,
      evidence: [`current_sessions=${currentSessions.length}`, `previous_sessions=${previousSessions.length}`]
    },
    {
      name: "主 workflow",
      signal: topWorkflow ?? "暂无稳定 workflow",
      evidence: stableWorkflows.slice(0, 3)
    },
    {
      name: "领域重心",
      signal: topDomain ?? "暂无稳定领域",
      evidence: topDomains.map(([name, count]) => `${name}:${count}`)
    }
  ];
  const reportDir = options?.outputDir
    ? path.resolve(options.outputDir)
    : path.join(storage.root, "artifacts", "birthday", "latest");
  const assetDir = path.join(reportDir, "assets");
  const derivedDir = path.join(storage.root, "derived", "birthday");
  const historyDir = path.join(derivedDir, "history");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  const capsulePath = path.join(derivedDir, "latest.json");
  const capsuleHistoryPath = path.join(historyDir, `${stamp}.json`);
  const htmlPath = path.join(reportDir, "birthday.html");
  const mdPath = path.join(reportDir, "birthday.md");
  const posterPath = path.join(assetDir, "birthday-poster.png");
  const sourceHash = sha256(JSON.stringify({
    generatedAt,
    periodDays,
    currentSessions: currentSessions.length,
    previousSessions: previousSessions.length,
    topSkills,
    stableWorkflows,
    topDomains,
    currentQuality,
    previousQuality
  }));
  const capsule: BirthdayCapsule = {
    schema_version: 1,
    generated_at: generatedAt,
    project_id: storage.buildAgentContext().project_id,
    period_days: periodDays,
    sample_count: currentSessions.length,
    previous_sample_count: previousSessions.length,
    north_star: northStar,
    retained_commitments: retainedCommitments,
    stable_workflows: stableWorkflows,
    emerging_skills: emergingSkills,
    changed_habits: changedHabits,
    growth_vectors: growthVectors,
    risks_to_watch: risksToWatch,
    next_year_targets: nextYearTargets,
    agent_instructions: [
      "Read birthday_memory from nms context before personalized work.",
      "Preserve north_star unless the user explicitly changes it.",
      "Treat next_year_targets as long-term guidance, not hard requirements.",
      "Never use birthday narrative to bypass safety, review, tests, or real-data constraints."
    ],
    artifacts: {
      capsule_ref: path.relative(storage.root, capsulePath).replaceAll("\\", "/"),
      html_report_ref: path.relative(storage.root, htmlPath).replaceAll("\\", "/"),
      markdown_ref: path.relative(storage.root, mdPath).replaceAll("\\", "/"),
      poster_ref: options?.image ? path.relative(storage.root, posterPath).replaceAll("\\", "/") : undefined
    }
  };

  const posterPrompt = [
    "生成一张 NMS birthday memory poster，主题是“每天重启，但不忘北极星”。",
    `必须只使用真实数据：sample_count=${capsule.sample_count}, behavior_score=${currentQuality.behavior_score}, workflows=${stableWorkflows.join(" | ") || "样本不足"}, skills=${topSkills.map(([name, count]) => `${name}:${count}`).join(" | ") || "样本不足"}.`,
    "画面风格：未来感控制台、温暖生日仪式、Agent 记忆胶囊、中文标题“NMS Birthday”。",
    "如果样本不足，画面必须标注“样本不足，正在学习”。不要编造额外 skill 或人格结论。"
  ].join("\n");
  if (options?.image) {
    const promptDir = path.join(storage.root, "artifacts", "prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const promptPath = path.join(promptDir, `birthday-poster-${stamp}.md`);
    fs.writeFileSync(promptPath, posterPrompt, "utf8");
    storage.recordArtifact({
      type: "prompt",
      path: path.relative(storage.root, promptPath).replaceAll("\\", "/"),
      source_data_hash: sourceHash,
      real_data_only: true,
      metadata: { kind: "birthday-poster", period_days: periodDays }
    });
    await generateImageViaRelay({
      prompt: posterPrompt,
      outputPath: posterPath,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model
    });
    storage.recordArtifact({
      type: "image",
      path: path.relative(storage.root, posterPath).replaceAll("\\", "/"),
      source_data_hash: sourceHash,
      real_data_only: true,
      metadata: { kind: "birthday-poster", model: options.model ?? process.env.NMS_IMAGE_MODEL ?? "gpt-image-2" }
    });
  }

  fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2), "utf8");
  fs.writeFileSync(capsuleHistoryPath, JSON.stringify(capsule, null, 2), "utf8");
  const md = `# NMS Birthday Memory Capsule

生成时间：${generatedAt}

> 这不是一次性总结，而是后续 Agent 会读取的进化资产。

## North Star

${northStar}

## Retained Commitments

${retainedCommitments.map((item) => `- ${item}`).join("\n")}

## Stable Workflows

${stableWorkflows.map((item) => `- ${item}`).join("\n") || "- 样本不足，暂无稳定 workflow。"}

## Emerging Skills

${emergingSkills.map((item) => `- ${item}`).join("\n") || "- 暂无新高频 skill。"}

## Changed Habits

${changedHabits.map((item) => `- ${item}`).join("\n")}

## Next Year Targets

${nextYearTargets.map((item) => `- ${item}`).join("\n")}

## Agent Instructions

${capsule.agent_instructions.map((item) => `- ${item}`).join("\n")}
`;
  fs.writeFileSync(mdPath, md, "utf8");

  const html = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NMS Birthday Memory Capsule</title>
  <style>
    :root { color-scheme: dark; --bg:#05070d; --panel:rgba(15,23,42,.78); --line:rgba(148,163,184,.24); --text:#eef2ff; --muted:#9ca3af; --cyan:#22d3ee; --gold:#fbbf24; --green:#34d399; --rose:#fb7185; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Aptos Display","Segoe UI","PingFang SC",sans-serif; background: radial-gradient(circle at 12% 4%, rgba(34,211,238,.25), transparent 30%), radial-gradient(circle at 88% 0%, rgba(251,191,36,.18), transparent 26%), linear-gradient(180deg,#080b16,#03050a 70%); color:var(--text); }
    main { max-width:1180px; margin:0 auto; padding:48px 22px; }
    .hero,.card { border:1px solid var(--line); background:var(--panel); border-radius:30px; box-shadow:0 24px 90px rgba(0,0,0,.35); }
    .hero { padding:38px; overflow:hidden; position:relative; }
    .hero:after { content:""; position:absolute; inset:auto -90px -90px auto; width:280px; height:280px; border-radius:50%; background:radial-gradient(circle, rgba(251,191,36,.2), transparent 70%); }
    .eyebrow { color:var(--cyan); letter-spacing:.16em; text-transform:uppercase; font-size:12px; }
    h1 { font-size:clamp(40px,6vw,82px); line-height:.92; margin:14px 0; max-width:900px; }
    .subtitle { color:var(--muted); font-size:18px; line-height:1.7; max-width:760px; }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin:22px 0; }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
    .card { padding:24px; margin-top:18px; }
    .metric { font-size:36px; font-weight:850; margin-top:8px; }
    .muted { color:var(--muted); }
    h2 { margin:0 0 14px; font-size:24px; }
    .pulse { display:inline-block; width:10px; height:10px; border-radius:50%; background:var(--green); box-shadow:0 0 26px var(--green); margin-right:8px; }
    .node { border:1px solid rgba(34,211,238,.35); background:rgba(34,211,238,.1); color:#cffafe; padding:9px 12px; border-radius:999px; display:inline-block; margin:5px; }
    .target { border-left:4px solid var(--gold); padding:12px 14px; background:rgba(251,191,36,.08); border-radius:16px; margin:10px 0; }
    .risk { border-left:4px solid var(--rose); padding:12px 14px; background:rgba(251,113,133,.08); border-radius:16px; margin:10px 0; }
    .list { display:grid; gap:10px; }
    .item { padding:12px 14px; border:1px solid var(--line); border-radius:16px; background:rgba(2,6,23,.28); }
    img { width:100%; border-radius:22px; border:1px solid var(--line); margin-top:16px; }
    code { color:#cffafe; }
    @media (max-width:900px){ .grid,.two{ grid-template-columns:repeat(2,1fr);} }
    @media (max-width:560px){ main{padding:24px 14px}.grid,.two{ grid-template-columns:1fr}.hero{padding:24px} }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow"><span class="pulse"></span>NMS Birthday · Living Agent Asset</div>
    <h1>每天重启，但不忘北极星。</h1>
    <p class="subtitle">这不是一份生日总结，而是一枚会被后续 Agent 读取的记忆胶囊。它保留目标、边界和可继承经验，让下一次 /nms-auto 不从零开始。</p>
    <div class="grid">
      <div class="card"><div class="muted">本周期真实样本</div><div class="metric">${capsule.sample_count}</div></div>
      <div class="card"><div class="muted">上周期样本</div><div class="metric">${capsule.previous_sample_count}</div></div>
      <div class="card"><div class="muted">Behavior Score</div><div class="metric">${currentQuality.behavior_score}</div></div>
      <div class="card"><div class="muted">Workflow Confidence</div><div class="metric">${Math.round(currentQuality.workflow_confidence * 100)}%</div></div>
    </div>
  </section>
  ${capsule.sample_count === 0 ? `<section class="card risk"><h2>样本不足</h2><p>当前没有足够真实 session。NMS 不会编造生日画像，只会保留目标和安全边界。</p></section>` : ""}
  <section class="card">
    <h2>North Star</h2>
    <div class="target">${escapeHtml(capsule.north_star)}</div>
  </section>
  <section class="two">
    <div class="card">
      <h2>保留下来的承诺</h2>
      <div class="list">${capsule.retained_commitments.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
    </div>
    <div class="card">
      <h2>下一岁路线图</h2>
      <div class="list">${capsule.next_year_targets.map((item) => `<div class="target">${escapeHtml(item)}</div>`).join("")}</div>
    </div>
  </section>
  <section class="card">
    <h2>稳定 Workflow</h2>
    ${capsule.stable_workflows.length > 0 ? capsule.stable_workflows.map((item) => `<span class="node">${escapeHtml(item)}</span>`).join("") : `<p class="muted">暂无稳定 workflow，先通过真实 ingest 继续学习。</p>`}
  </section>
  <section class="two">
    <div class="card">
      <h2>新出现的能力信号</h2>
      <div class="list">${capsule.emerging_skills.length > 0 ? capsule.emerging_skills.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("") : `<div class="item">暂无新高频 skill。</div>`}</div>
    </div>
    <div class="card">
      <h2>需要警惕的风险</h2>
      <div class="list">${capsule.risks_to_watch.map((item) => `<div class="risk">${escapeHtml(item)}</div>`).join("")}</div>
    </div>
  </section>
  <section class="card">
    <h2>Agent 会继承什么</h2>
    <div class="list">${capsule.agent_instructions.map((item) => `<div class="item"><code>${escapeHtml(item)}</code></div>`).join("")}</div>
    <p class="muted">Capsule: ${escapeHtml(capsule.artifacts.capsule_ref)} · Markdown: ${escapeHtml(capsule.artifacts.markdown_ref)}</p>
  </section>
  ${fs.existsSync(posterPath) ? `<section class="card"><h2>Birthday Poster</h2><img src="${path.relative(reportDir, posterPath).replaceAll("\\", "/")}" alt="birthday poster" /></section>` : ""}
</main>
</body>
</html>`;
  fs.writeFileSync(htmlPath, html, "utf8");
  storage.recordArtifact({
    type: "context",
    path: capsule.artifacts.capsule_ref,
    source_data_hash: sourceHash,
    real_data_only: true,
    metadata: { kind: "birthday-capsule", period_days: periodDays }
  });
  storage.recordArtifact({
    type: "report",
    path: capsule.artifacts.html_report_ref,
    source_data_hash: sourceHash,
    real_data_only: true,
    metadata: { kind: "birthday-report", format: "html", period_days: periodDays }
  });
  storage.recordEvent("REPORT_GENERATED", capsule.artifacts.html_report_ref, sourceHash);

  const payload = {
    generated_at: generatedAt,
    capsule,
    paths: {
      capsule: capsulePath,
      history: capsuleHistoryPath,
      html: htmlPath,
      markdown: mdPath,
      poster: fs.existsSync(posterPath) ? posterPath : null
    },
    next_step: "Run /nms-auto; it will now inherit birthday_memory through nms context."
  };
  if (options?.format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Birthday ==",
    "Mode: living memory capsule + birthday report",
    `North Star: ${capsule.north_star}`,
    `Samples: ${capsule.sample_count}`,
    `Stable Workflow: ${capsule.stable_workflows[0] ?? "(not enough data yet)"}`,
    `Next Target: ${capsule.next_year_targets[0]}`,
    `Capsule: ${capsulePath}`,
    `Report: ${htmlPath}`,
    fs.existsSync(posterPath) ? `Poster: ${posterPath}` : "Poster: not generated (use --image when image relay is configured)",
    payload.next_step
  ].join("\n");
}
