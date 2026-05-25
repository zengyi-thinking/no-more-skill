import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { z } from "zod";
import { readPlannerInput, runNightHarness } from "./harness/engine.js";
import { processCompressedEvent } from "./hook/engine.js";
import { JsonStorage } from "./storage.js";
import type { HookInput, SessionRecord, Stats } from "./types.js";

const InputSchema = z.object({
  compressed_text: z.string(),
  conversation: z.string(),
  tool: z.enum(["claude", "codex", "opencode"])
});

function readPayload(inputFile?: string): string {
  if (inputFile) return fs.readFileSync(inputFile, "utf8");
  return fs.readFileSync(0, "utf8");
}

export function ingestCommand(inputFile?: string): string {
  const raw = readPayload(inputFile);
  const parsed = InputSchema.parse(JSON.parse(raw)) as HookInput;
  const out = processCompressedEvent(parsed);
  return JSON.stringify(out, null, 2);
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
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
} {
  const skillCounts: Record<string, number> = {};
  const workflowCounts: Record<string, number> = {};
  for (const session of sessions) {
    for (const skill of session.skills_used) skillCounts[skill] = (skillCounts[skill] ?? 0) + 1;
    const workflow = session.workflow.join(" -> ");
    if (workflow) workflowCounts[workflow] = (workflowCounts[workflow] ?? 0) + 1;
  }
  return { skillCounts, workflowCounts };
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

function inferSessionDomain(session: { compressed_text: string; conversation: string }): string {
  const text = `${session.compressed_text}\n${session.conversation}`.toLowerCase();
  if (/写作|文章|标题|大纲|草稿|发布/.test(text)) return "writing";
  if (/研究|资料|来源|引用|验证|论文/.test(text)) return "research";
  if (/学习|课程|练习|复盘|掌握/.test(text)) return "learning";
  if (/产品|用户|需求|原型|推广|演示/.test(text)) return "product";
  if (/口播|分镜|视频|图片|内容/.test(text)) return "content";
  return "coding";
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
  const domain = options?.domain;
  const scopedSessions = domain ? db.sessions.filter((s) => inferSessionDomain(s) === domain) : db.sessions;
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
  const payload = {
    recent_workflow: recent,
    domain: domain ?? "all",
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
    "Warnings:",
    ...(context.data_quality.warnings.length > 0 ? context.data_quality.warnings : ["(none)"])
  ].join("\n");
}

export function flowVisualCommand(): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const topSkills = Object.entries(db.stats.skill_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const quality = db.stats.quality_metrics;
  const html = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NMS Flow Dashboard</title>
  <style>
    body { font-family: "Segoe UI", "PingFang SC", sans-serif; margin: 0; background: linear-gradient(135deg,#0f172a,#1e293b); color: #e2e8f0; }
    .wrap { max-width: 980px; margin: 24px auto; padding: 20px; }
    .card { background: rgba(15,23,42,0.75); border: 1px solid rgba(148,163,184,0.25); border-radius: 14px; padding: 16px; margin-bottom: 16px; backdrop-filter: blur(4px); }
    .title { font-size: 24px; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; }
    .kpi { background: rgba(30,41,59,0.8); border-radius: 10px; padding: 10px; }
    .kpi .v { font-size: 22px; font-weight: 700; }
    .bar { height: 12px; background: #1f2937; border-radius: 8px; overflow: hidden; margin-top: 6px; }
    .bar > div { height: 100%; background: linear-gradient(90deg,#22c55e,#3b82f6); }
    .skill { margin: 8px 0; }
    .label { display:flex; justify-content:space-between; font-size:14px; }
    code { background: #0b1220; padding: 2px 6px; border-radius: 6px; color: #93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">NMS 行为驾驶舱 / Behavior Cockpit</div>
      <div class="grid">
        <div class="kpi"><div>Behavior Score</div><div class="v">${quality.behavior_score}</div></div>
        <div class="kpi"><div>Workflow Confidence</div><div class="v">${Math.round(
          quality.workflow_confidence * 100
        )}%</div></div>
        <div class="kpi"><div>Session Velocity(7d)</div><div class="v">${quality.session_velocity_7d}</div></div>
        <div class="kpi"><div>Streak Days</div><div class="v">${quality.streak_days}</div></div>
      </div>
    </div>
    <div class="card">
      <h3>Top Skills</h3>
      ${topSkills
        .map(
          ([name, count]) => `
        <div class="skill">
          <div class="label"><span>${name}</span><span>${count}</span></div>
          <div class="bar"><div style="width:${Math.min(100, count * 20)}%"></div></div>
        </div>`
        )
        .join("")}
      <p>Use <code>nms flow --format json</code> for raw machine-readable data.</p>
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
}): string {
  const started = performance.now();
  const apply = Boolean(options.apply);
  const dryRun = apply ? false : options.dryRun ?? true;
  const plannerInput = options.taskFile ? readPlannerInput(options.taskFile) : undefined;
  const report = runNightHarness({
    dryRun,
    apply,
    explain: Boolean(options.explain),
    plannerInput,
    timeBudgetMinutes: options.timeBudget ?? 5
  });
  const storage = new JsonStorage();
  storage.trackPerf("night_ms", Number((performance.now() - started).toFixed(2)));
  storage.recordNightRun(report);
  return JSON.stringify(report, null, 2);
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
  realOnly?: boolean;
}): Promise<string> {
  const storage = new JsonStorage();
  const db = storage.load();
  const period = options?.period ?? "7d";
  const reportSessions = filterSessionsByPeriod(db.sessions, period);
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
  const quality = reportQualityMetrics(reportSessions, counts.workflowCounts);
  const sourceHash = sha256(JSON.stringify({ sessions: reportSessions.length, period, topSkills, topWorkflows, quality }));

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
    .join(", ")}。风格：深色科技、清晰标签、中文标题“技能使用频率”。`;
  const progressPrompt = `${realDataNotice} 制作项目进展图：${progressSummary}。包含workflow排名：${topWorkflows
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}。风格：产品周报图表、专业、简洁。`;
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
        metadata: { slug, period: options.period ?? "7d" }
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
    real_only: options?.realOnly ?? true,
    sample_count: reportSessions.length,
    top_skills: topSkills,
    top_workflows: topWorkflows,
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
      metadata: { format: "json", period: options.period ?? "7d" }
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

## 2) 最近工作进展

${progressSummary}

${topWorkflows.map(([k, v], i) => `${i + 1}. ${k} (${v})`).join("\n") || "(暂无数据)"}

${fs.existsSync(progressImg) ? `![work-progress](${path.relative(reportDir, progressImg).replaceAll("\\", "/")})` : ""}

## 3) 人格演化 / 风格演化

- 当前风格：${db.user_profile.style}
- Top Skills：${db.user_profile.top_skills.join(", ") || "(暂无)"}
- Top Workflows：${db.user_profile.top_workflows.join(", ") || "(暂无)"}
- Behavior Score：${quality.behavior_score}

${fs.existsSync(personaImg) ? `![persona-evolution](${path.relative(reportDir, personaImg).replaceAll("\\", "/")})` : ""}

## 4) 说明

${imageNotes.map((n) => `- ${n}`).join("\n")}
`;

  if (options?.format === "html") {
    const maxSkill = Math.max(1, ...topSkills.map(([, count]) => count));
    const html = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NMS Agent Daily Report</title>
  <style>
    :root { color-scheme: dark; --bg:#080b12; --panel:#111827; --line:rgba(148,163,184,.24); --text:#eef2ff; --muted:#94a3b8; --cyan:#22d3ee; --green:#34d399; --amber:#fbbf24; --red:#fb7185; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Aptos Display", "Segoe UI", "PingFang SC", sans-serif; background: radial-gradient(circle at 10% 10%, rgba(34,211,238,.22), transparent 32%), radial-gradient(circle at 80% 0%, rgba(251,191,36,.12), transparent 28%), var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 48px 24px; }
    .hero { border: 1px solid var(--line); border-radius: 28px; padding: 34px; background: linear-gradient(145deg, rgba(17,24,39,.92), rgba(15,23,42,.68)); box-shadow: 0 24px 90px rgba(0,0,0,.36); }
    .eyebrow { color: var(--cyan); letter-spacing: .16em; text-transform: uppercase; font-size: 12px; }
    h1 { font-size: clamp(38px, 6vw, 78px); line-height: .94; margin: 16px 0; max-width: 900px; }
    .subtitle { color: var(--muted); font-size: 18px; line-height: 1.7; max-width: 760px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 22px 0; }
    .card { border: 1px solid var(--line); border-radius: 22px; padding: 20px; background: rgba(17,24,39,.74); }
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
    .warning { border-color: rgba(251,113,133,.35); background: rgba(127,29,29,.22); color: #fecdd3; }
    img { width: 100%; border-radius: 18px; border: 1px solid var(--line); margin-top: 12px; }
    @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } main { padding: 24px 14px; } .hero { padding: 22px; } }
  </style>
</head>
<body>
<main>
  <div class="hero">
    <div class="eyebrow">No More Skill · Real Behavior Report</div>
    <h1>把 Agent 的日常操作，变成可复盘的行为地图。</h1>
    <p class="subtitle">本报告只读取本地 .nms 真实数据。样本不足时会明确标注，不补虚构指标。</p>
    <div class="grid">
      <div class="card"><div class="muted">真实样本</div><div class="metric">${reportSessions.length}</div></div>
      <div class="card"><div class="muted">Behavior Score</div><div class="metric">${quality.behavior_score}</div></div>
      <div class="card"><div class="muted">Workflow Confidence</div><div class="metric">${Math.round(quality.workflow_confidence * 100)}%</div></div>
      <div class="card"><div class="muted">Stale Risk</div><div class="metric">${quality.stale_risk}%</div></div>
    </div>
  </div>
  ${reportSessions.length === 0 ? `<section class="card warning"><h2>数据不足</h2><p>当前周期没有足够真实 session。请先运行 <code>nms ingest --input input.json</code>，再生成报告。</p></section>` : ""}
  <section class="card">
    <h2>Skill 使用频率</h2>
    ${
      topSkills.length > 0
        ? topSkills
            .map(
              ([name, count]) => `<div class="bar-row"><div class="bar-label"><span>${name}</span><span>${count}</span></div><div class="bar"><span style="width:${Math.max(6, Math.round((count / maxSkill) * 100))}%"></span></div></div>`
            )
            .join("")
        : `<p class="muted">暂无 skill 频率数据。</p>`
    }
    ${fs.existsSync(skillImg) ? `<img src="${path.relative(reportDir, skillImg).replaceAll("\\", "/")}" alt="skill frequency" />` : ""}
  </section>
  <section class="card">
    <h2>Workflow 路径</h2>
    <div class="timeline">
      ${
        topWorkflows.length > 0
          ? topWorkflows
              .map(([wf, count], index) => `<div class="step"><div class="dot">${index + 1}</div><div><strong>${wf}</strong><div class="muted">出现 ${count} 次</div></div></div>`)
              .join("")
          : `<p class="muted">暂无可稳定复现的 workflow。</p>`
      }
    </div>
    ${fs.existsSync(progressImg) ? `<img src="${path.relative(reportDir, progressImg).replaceAll("\\", "/")}" alt="work progress" />` : ""}
  </section>
  <section class="card">
    <h2>用户风格与人格演化</h2>
    <p>当前风格：<strong>${db.user_profile.style}</strong></p>
    <p class="muted">Top Skills：${db.user_profile.top_skills.join(", ") || "暂无"}</p>
    <p class="muted">Top Workflows：${db.user_profile.top_workflows.join(", ") || "暂无"}</p>
    ${fs.existsSync(personaImg) ? `<img src="${path.relative(reportDir, personaImg).replaceAll("\\", "/")}" alt="persona evolution" />` : ""}
  </section>
  <section class="card">
    <h2>下一步建议</h2>
    <div class="step"><div class="dot">1</div><div><strong>继续采集真实工作流</strong><div class="muted">next: nms ingest --input input.json</div></div></div>
    <div class="step"><div class="dot">2</div><div><strong>给 Agent 读取上下文</strong><div class="muted">next: nms context --task "你的任务" --format json</div></div></div>
    <div class="step"><div class="dot">3</div><div><strong>先 dry-run 再执行</strong><div class="muted">next: nms night --dry-run --explain --task-file task.json</div></div></div>
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
      metadata: { format: "html", period: options.period ?? "7d" }
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
    metadata: { format: "md", period }
  });
  storage.recordEvent("REPORT_GENERATED", path.relative(storage.root, reportPath).replaceAll("\\", "/"), sourceHash);
  return reportPath;
}
