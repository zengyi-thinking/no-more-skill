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
