import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { z } from "zod";
import { readPlannerInput, runNightHarness } from "./harness/engine.js";
import { processCompressedEvent } from "./hook/engine.js";
import { JsonStorage } from "./storage.js";
import type { HookInput } from "./types.js";

const InputSchema = z.object({
  compressed_text: z.string(),
  conversation: z.string(),
  tool: z.enum(["claude", "codex"])
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

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
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

export function flowCommand(format: "human" | "json" = "human"): string {
  const started = performance.now();
  const storage = new JsonStorage();
  const db = storage.load();
  const recent = storage.recentSessions(3).map((s) => s.workflow);
  const skillEntries = Object.entries(db.stats.skill_counts).sort((a, b) => b[1] - a[1]);
  const topSkills = skillEntries.slice(0, 5).map(([k, v]) => `${k}(${v})`);
  const idleSkills = skillEntries.slice(5).map(([k]) => k);
  const suggestions = flowSuggestions(db);
  const payload = {
    recent_workflow: recent,
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
  return JSON.stringify(report, null, 2);
}

export function doctorCommand(): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const checks: Array<{ check: string; status: "PASS" | "WARN"; detail: string }> = [];

  checks.push({
    check: "Schema Version",
    status: db.schema_version >= 2 ? "PASS" : "WARN",
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
  const result = await saveImageFromResponse(payload, options.outputPath);
  if (result !== "written") {
    throw new Error("Relay response does not include supported image data fields.");
  }
}

export async function reportCommand(options?: {
  image?: boolean;
  outputDir?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<string> {
  const storage = new JsonStorage();
  const db = storage.load();
  const reportDir = options?.outputDir
    ? path.resolve(options.outputDir)
    : path.join(process.cwd(), "docs", "reports", "latest");
  const assetDir = path.join(reportDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });

  const topSkills = Object.entries(db.stats.skill_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topWorkflows = Object.entries(db.stats.workflow_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const quality = db.stats.quality_metrics;

  const progressSummary = [
    `总会话数: ${db.sessions.length}`,
    `主工作流置信度: ${quality.workflow_confidence}`,
    `7日活跃度: ${quality.session_velocity_7d}`,
    `连续天数: ${quality.streak_days}`,
    `陈旧风险: ${quality.stale_risk}%`
  ].join("；");

  const skillPrompt = `制作专业信息图：展示NMS技能使用频率。数据：${topSkills
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}。风格：深色科技、清晰标签、中文标题“技能使用频率”。`;
  const progressPrompt = `制作项目进展图：${progressSummary}。包含workflow排名：${topWorkflows
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")}。风格：产品周报图表、专业、简洁。`;
  const personaPrompt = `制作人格演化图：style=${db.user_profile.style}，top_skills=${db.user_profile.top_skills.join(
    ","
  )}，top_workflows=${db.user_profile.top_workflows.join(
    ","
  )}，behavior_score=${quality.behavior_score}。风格：成长路径可视化、专业温暖。`;

  const skillImg = path.join(assetDir, "skill-frequency.png");
  const progressImg = path.join(assetDir, "work-progress.png");
  const personaImg = path.join(assetDir, "persona-evolution.png");

  const imageNotes: string[] = [];
  if (options?.image) {
    await generateImageViaRelay({
      prompt: skillPrompt,
      outputPath: skillImg,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model
    });
    await generateImageViaRelay({
      prompt: progressPrompt,
      outputPath: progressImg,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model
    });
    await generateImageViaRelay({
      prompt: personaPrompt,
      outputPath: personaImg,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model
    });
    imageNotes.push("三张可视化图片已通过中转站生成。");
  } else {
    imageNotes.push("未启用 --image，仅生成文本报告。");
  }

  const reportMd = `# NMS 可视化周报 / NMS Visual Report

更新时间：${new Date().toISOString()}

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

  const reportPath = path.join(reportDir, "report.md");
  fs.writeFileSync(reportPath, reportMd, "utf8");
  return reportPath;
}
