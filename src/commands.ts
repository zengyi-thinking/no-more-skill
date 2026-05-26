import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { z } from "zod";
import { DEFAULT_CONFIG } from "./config.js";
import { resolvePolicyProfile, validateWriteScope } from "./harness/guards.js";
import { readPlannerInput, runNightHarness } from "./harness/engine.js";
import { detectHostIntegrations, formatHostReport, writeHostCommandFiles } from "./host-integration.js";
import { processCompressedEvent } from "./hook/engine.js";
import { detectDomainFromText, detectSessionDomain, domainPackFor } from "./hook/domainPacks.js";
import { JsonStorage, redactText } from "./storage.js";
import { State } from "./types.js";
import type { AgentContext, BirthdayCapsule, HookConsumeSummary, HookInput, NightReport, PlannerOutput, PolicyProfileName, SessionRecord, Stats } from "./types.js";

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

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function trimSummary(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}...`;
}

function relativeToNmsRoot(storage: JsonStorage, filePath: string): string {
  return path.relative(storage.root, filePath).replaceAll("\\", "/");
}

function writeJsonArtifact(rootFile: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(rootFile), { recursive: true });
  fs.writeFileSync(rootFile, JSON.stringify(payload, null, 2), "utf8");
}

function nextSafeForFailure(code: string): string {
  switch (code) {
    case "POLICY_BLOCK":
      return "nms guard --format json";
    case "CONFIG_ERROR":
      return "nms doctor";
    case "TEST_FAIL":
    case "REVIEW_FAIL":
      return "nms night --dry-run --explain --task-file task.json";
    default:
      return "nms auto";
  }
}

function recordCommandAudit(storage: JsonStorage, input: {
  command: string;
  triggeredBy: string;
  policyProfile: PolicyProfileName;
  inputSummary: string;
  fileScope: string[];
  gateResult: string;
  artifactPaths: string[];
  notes?: string[];
}): string {
  return storage.recordAudit({
    command: input.command,
    triggered_by: input.triggeredBy,
    policy_profile: input.policyProfile,
    input_summary: input.inputSummary,
    file_scope: input.fileScope,
    gate_result: input.gateResult,
    artifact_paths: input.artifactPaths,
    notes: input.notes ?? []
  });
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
    "- nms ingest --watch .nms/inbox",
    "- nms hook ingest-file .nms/inbox/event.json",
    "- cat input.json | nms ingest",
    "Required payload:",
    "{\"compressed_text\":\"...\",\"conversation\":\"...\",\"tool\":\"claude|codex|opencode\"}"
  ].join("\n");
}

function archiveHookFile(sourcePath: string, targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const fileName = `${nowStamp()}-${path.basename(sourcePath)}`;
  const target = path.join(targetDir, fileName);
  fs.renameSync(sourcePath, target);
  return target;
}

function buildHookErrorPayload(filePath: string, rawSummary: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "hook-ingest",
    source: filePath,
    reason: message,
    recovery_hint: "Ensure the file is valid JSON and matches { compressed_text, conversation, tool }.",
    next_safe_command: "nms doctor",
    input_summary: trimSummary(redactText(rawSummary || path.basename(filePath)))
  };
}

function processHookFile(filePath: string, storage = new JsonStorage(), moveAfterProcess = false): {
  status: "ingested" | "duplicate" | "failed";
  archivePath?: string;
  errorPath?: string;
  summary: string;
} {
  const raw = fs.readFileSync(filePath, "utf8");
  let inputSummary = trimSummary(raw);
  try {
    const parsed = InputSchema.parse(JSON.parse(raw)) as HookInput;
    inputSummary = trimSummary(redactText(`${parsed.tool}: ${parsed.compressed_text}`));
    const duplicate = storage.findDuplicateSession(storage.load(), parsed);
    const out = processCompressedEvent(parsed, storage);
    const status = duplicate ? "duplicate" : "ingested";
    const archivePath = moveAfterProcess
      ? archiveHookFile(filePath, path.join(storage.root, "inbox", "archive"))
      : undefined;
    const archiveRef = archivePath ? relativeToNmsRoot(storage, archivePath) : undefined;
    recordCommandAudit(storage, {
      command: "hook-ingest-file",
      triggeredBy: "local-cli",
      policyProfile: "normal",
      inputSummary,
      fileScope: [filePath],
      gateResult: status.toUpperCase(),
      artifactPaths: [archiveRef].filter((value): value is string => Boolean(value)),
      notes: [`skills=${out.skills_used.join(",") || "(none)"}`]
    });
    return { status, archivePath, summary: inputSummary };
  } catch (error) {
    const errorArtifact = storage.recordErrorArtifact(buildHookErrorPayload(filePath, inputSummary, error));
    const failedPath = moveAfterProcess
      ? archiveHookFile(filePath, path.join(storage.root, "inbox", "failed"))
      : undefined;
    recordCommandAudit(storage, {
      command: "hook-ingest-file",
      triggeredBy: "local-cli",
      policyProfile: "normal",
      inputSummary,
      fileScope: [filePath],
      gateResult: "FAILED",
      artifactPaths: [
        relativeToNmsRoot(storage, errorArtifact),
        ...(failedPath ? [relativeToNmsRoot(storage, failedPath)] : [])
      ],
      notes: [error instanceof Error ? error.message : String(error)]
    });
    return {
      status: "failed",
      archivePath: failedPath,
      errorPath: errorArtifact,
      summary: inputSummary
    };
  }
}

export function hookIngestFileCommand(filePath: string): string {
  const storage = new JsonStorage();
  const result = processHookFile(path.resolve(filePath), storage, false);
  return JSON.stringify(
    {
      file: path.resolve(filePath),
      status: result.status,
      archive_path: result.archivePath ?? null,
      error_path: result.errorPath ?? null,
      summary: result.summary
    },
    null,
    2
  );
}

export function ingestWatchCommand(watchDir?: string): string {
  const storage = new JsonStorage();
  const dir = path.resolve(watchDir ?? path.join(storage.root, "inbox"));
  fs.mkdirSync(dir, { recursive: true });
  const queue = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
  const summary: HookConsumeSummary = {
    generated_at: new Date().toISOString(),
    watched_dir: dir,
    processed: 0,
    ingested: 0,
    duplicates: 0,
    failed: 0,
    archived: [],
    failed_records: []
  };
  const notes: string[] = [];
  for (const file of queue) {
    const result = processHookFile(file, storage, true);
    summary.processed += 1;
    if (result.status === "ingested") summary.ingested += 1;
    if (result.status === "duplicate") summary.duplicates += 1;
    if (result.status === "failed") summary.failed += 1;
    if (result.archivePath) summary.archived.push(result.archivePath);
    if (result.errorPath) summary.failed_records.push(result.errorPath);
    notes.push(`${path.basename(file)}:${result.status}`);
  }
  recordCommandAudit(storage, {
    command: "ingest-watch",
    triggeredBy: "local-cli",
    policyProfile: "normal",
    inputSummary: `consume inbox ${dir}`,
    fileScope: queue.map((file) => file.replaceAll("\\", "/")),
    gateResult: summary.failed > 0 ? "PARTIAL" : "OK",
    artifactPaths: [
      ...summary.archived.map((file) => relativeToNmsRoot(storage, file)),
      ...summary.failed_records.map((file) => relativeToNmsRoot(storage, file))
    ],
    notes
  });
  return JSON.stringify(summary, null, 2);
}

export async function ingestWatchLoopCommand(watchDir?: string, pollIntervalMs = 2000): Promise<string> {
  const storage = new JsonStorage();
  const dir = path.resolve(watchDir ?? path.join(storage.root, "inbox"));
  fs.mkdirSync(dir, { recursive: true });
  const processed = new Set<string>();
  const summary: HookConsumeSummary = {
    generated_at: new Date().toISOString(),
    watched_dir: dir,
    processed: 0,
    ingested: 0,
    duplicates: 0,
    failed: 0,
    archived: [],
    failed_records: []
  };
  const scan = () => {
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
    for (const file of files) {
      const key = path.basename(file);
      if (processed.has(key)) continue;
      processed.add(key);
      const result = processHookFile(file, storage, true);
      summary.processed += 1;
      if (result.status === "ingested") summary.ingested += 1;
      if (result.status === "duplicate") summary.duplicates += 1;
      if (result.status === "failed") summary.failed += 1;
      if (result.archivePath) summary.archived.push(result.archivePath);
      if (result.errorPath) summary.failed_records.push(result.errorPath);
      process.stdout.write(`${JSON.stringify({ file: key, status: result.status, summary: result.summary })}\n`);
    }
  };
  process.stdout.write(`Watching ${dir} for real hook payloads. Press Ctrl+C to stop.\n`);
  scan();
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    const timer = setInterval(scan, pollIntervalMs);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  recordCommandAudit(storage, {
    command: "ingest-watch-loop",
    triggeredBy: "local-cli",
    policyProfile: "normal",
    inputSummary: `watch ${dir}`,
    fileScope: [],
    gateResult: summary.failed > 0 ? "PARTIAL" : "OK",
    artifactPaths: [...summary.archived.map((file) => relativeToNmsRoot(storage, file)), ...summary.failed_records.map((file) => relativeToNmsRoot(storage, file))],
    notes: [`processed=${summary.processed}`, `ingested=${summary.ingested}`, `duplicates=${summary.duplicates}`, `failed=${summary.failed}`]
  });
  return JSON.stringify(summary, null, 2);
}

export function onboardingCommand(format: "human" | "json" = "human"): string {
  const data = JSON.parse(dataStatusCommand("json")) as {
    sample_count: number;
    latest_session_at: string | null;
    quality: Stats["quality_metrics"];
    warnings: string[];
  };
  const hostReport = detectHostIntegrations();
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
    host_integrations: hostReport.hosts.map((host) => ({
      name: host.name,
      status: host.status,
      command: host.invocation[0],
      fix_hint: host.fix_hint
    })),
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
    "== 宿主调用状态 / Host Invocation ==",
    ...payload.host_integrations.map((host) => `- ${host.name}: ${host.status} · ${host.command}`),
    "如果 /nms 不出现：运行 nms hosts --write-commands，然后重启 Claude Code/OpenCode。",
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

function countDirectFiles(root: string, suffix?: string): number {
  if (!fs.existsSync(root)) return 0;
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
    .length;
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

type VisualTheme = "flow" | "report" | "birthday";

function visualAccent(theme: VisualTheme): { accent: string; accentSoft: string; glow: string; signal: string } {
  if (theme === "birthday") {
    return {
      accent: "#f6c453",
      accentSoft: "rgba(246,196,83,.18)",
      glow: "rgba(246,196,83,.18)",
      signal: "#f97316"
    };
  }
  if (theme === "report") {
    return {
      accent: "#60a5fa",
      accentSoft: "rgba(96,165,250,.18)",
      glow: "rgba(34,211,238,.16)",
      signal: "#34d399"
    };
  }
  return {
    accent: "#22d3ee",
    accentSoft: "rgba(34,211,238,.18)",
    glow: "rgba(34,211,238,.16)",
    signal: "#34d399"
  };
}

function visualShell(args: {
  theme: VisualTheme;
  title: string;
  eyebrow: string;
  headline: string;
  subtitle: string;
  metrics: Array<{ label: string; value: string; note?: string }>;
  body: string;
}): string {
  const accent = visualAccent(args.theme);
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(args.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg:#070a13;
      --bg-2:#04060d;
      --panel:rgba(10,15,26,.8);
      --panel-strong:rgba(12,18,30,.94);
      --line:rgba(148,163,184,.18);
      --text:#eff4ff;
      --muted:#95a3bb;
      --accent:${accent.accent};
      --accent-soft:${accent.accentSoft};
      --signal:${accent.signal};
      --danger:#fb7185;
      --glow:${accent.glow};
      --radius-xl:30px;
      --radius-lg:22px;
      --radius-md:16px;
      --shadow:0 26px 90px rgba(0,0,0,.36);
    }
    * { box-sizing: border-box; }
    body {
      margin:0;
      font-family:"Aptos Display","Segoe UI","PingFang SC",sans-serif;
      background:
        radial-gradient(circle at 12% 2%, var(--glow), transparent 26%),
        radial-gradient(circle at 86% 0%, var(--accent-soft), transparent 24%),
        linear-gradient(180deg,var(--bg),var(--bg-2) 70%);
      color:var(--text);
    }
    main { max-width: 1220px; margin: 0 auto; padding: 38px 18px 64px; }
    .hero,.card {
      border:1px solid var(--line);
      background:linear-gradient(180deg,var(--panel-strong),var(--panel));
      border-radius:var(--radius-xl);
      box-shadow:var(--shadow);
    }
    .hero {
      padding:34px 28px 28px;
      position:relative;
      overflow:hidden;
    }
    .hero:after {
      content:"";
      position:absolute;
      inset:auto -80px -90px auto;
      width:260px;
      height:260px;
      border-radius:50%;
      background:radial-gradient(circle, var(--accent-soft), transparent 70%);
      pointer-events:none;
    }
    .eyebrow {
      color:var(--accent);
      font-size:12px;
      letter-spacing:.18em;
      text-transform:uppercase;
    }
    h1 {
      margin:14px 0 10px;
      font-size:clamp(38px,6vw,82px);
      line-height:.92;
      max-width:980px;
    }
    .subtitle {
      color:var(--muted);
      font-size:17px;
      line-height:1.75;
      max-width:820px;
      text-wrap:pretty;
    }
    .metric-grid {
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:14px;
      margin-top:22px;
    }
    .metric {
      border:1px solid var(--line);
      border-radius:var(--radius-lg);
      padding:16px;
      background:rgba(255,255,255,.02);
      min-height:112px;
    }
    .metric-label { color:var(--muted); font-size:14px; }
    .metric-value { font-size:34px; font-weight:850; margin-top:8px; }
    .metric-note { color:#c7d3ea; font-size:13px; margin-top:6px; }
    .grid-2 {
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:18px;
      margin-top:18px;
    }
    .grid-3 {
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:18px;
      margin-top:18px;
    }
    .card { padding:22px; margin-top:18px; }
    h2 { margin:0 0 14px; font-size:24px; }
    h3 { margin:0 0 10px; font-size:18px; }
    .muted { color:var(--muted); }
    .bar-row { margin:14px 0; }
    .bar-label {
      display:flex;
      justify-content:space-between;
      gap:12px;
      font-size:14px;
      color:#dce8ff;
    }
    .bar {
      height:12px;
      border-radius:999px;
      background:rgba(148,163,184,.12);
      margin-top:8px;
      overflow:hidden;
    }
    .bar > span {
      display:block;
      height:100%;
      border-radius:inherit;
      background:linear-gradient(90deg,var(--accent),var(--signal));
    }
    .timeline { display:grid; gap:12px; }
    .step {
      display:flex;
      gap:12px;
      align-items:flex-start;
    }
    .dot {
      width:30px;
      height:30px;
      flex:0 0 auto;
      display:grid;
      place-items:center;
      border-radius:50%;
      border:1px solid color-mix(in srgb, var(--accent) 55%, transparent);
      background:color-mix(in srgb, var(--accent) 18%, transparent);
      color:var(--accent);
      font-weight:700;
    }
    .path {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      align-items:center;
    }
    .node,.pill,.delta-pill {
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:8px 12px;
      border-radius:999px;
      border:1px solid color-mix(in srgb, var(--accent) 38%, transparent);
      background:color-mix(in srgb, var(--accent) 12%, transparent);
      color:#d9f6ff;
      margin:4px 8px 4px 0;
    }
    .arrow { color:var(--accent); font-weight:800; }
    .delta-pill.negative {
      border-color:rgba(251,113,133,.36);
      background:rgba(251,113,133,.12);
      color:#ffd8df;
    }
    .delta-pill.neutral {
      border-color:rgba(148,163,184,.24);
      background:rgba(148,163,184,.1);
      color:#e2e8f0;
    }
    .callout {
      border-radius:var(--radius-lg);
      padding:16px 18px;
      border:1px solid var(--line);
      background:rgba(255,255,255,.02);
    }
    .callout.warning {
      border-color:rgba(251,113,133,.34);
      background:rgba(127,29,29,.2);
      color:#ffe4ea;
    }
    .lane {
      border-radius:var(--radius-lg);
      border:1px solid var(--line);
      background:rgba(255,255,255,.02);
      padding:16px;
      min-height:220px;
    }
    .lane.keep { border-color:rgba(52,211,153,.28); }
    .lane.stop { border-color:rgba(251,113,133,.28); }
    .lane.new { border-color:rgba(245,158,11,.28); }
    .list { display:grid; gap:10px; }
    .item {
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px 14px;
      background:rgba(255,255,255,.02);
      text-wrap:pretty;
    }
    .source {
      border-top:1px solid var(--line);
      margin-top:18px;
      padding-top:14px;
      color:var(--muted);
      font-size:13px;
      line-height:1.7;
    }
    img {
      width:100%;
      border-radius:18px;
      border:1px solid var(--line);
      margin-top:14px;
    }
    code {
      color:#cfeeff;
      background:#091120;
      border-radius:8px;
      padding:2px 6px;
    }
    @media (max-width: 980px) {
      .metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .grid-2, .grid-3 { grid-template-columns:1fr; }
    }
    @media (max-width: 560px) {
      main { padding:20px 12px 40px; }
      .hero { padding:24px 18px 20px; }
      .metric-grid { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div class="eyebrow">${args.eyebrow}</div>
    <h1>${args.headline}</h1>
    <p class="subtitle">${args.subtitle}</p>
    <div class="metric-grid">
      ${args.metrics
        .map(
          (metric) => `<div class="metric"><div class="metric-label">${escapeHtml(metric.label)}</div><div class="metric-value">${escapeHtml(metric.value)}</div>${metric.note ? `<div class="metric-note">${escapeHtml(metric.note)}</div>` : ""}</div>`
        )
        .join("")}
    </div>
  </section>
  ${args.body}
</main>
</body>
</html>`;
}

function renderBarRows(entries: Array<{ label: string; value: number; note?: string }>, emptyText: string): string {
  const max = Math.max(1, ...entries.map((entry) => entry.value));
  if (entries.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return entries
    .map((entry) => {
      const width = Math.max(6, Math.round((entry.value / max) * 100));
      return `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(entry.label)}</span><span>${entry.value}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</span></div><div class="bar"><span style="width:${width}%"></span></div></div>`;
    })
    .join("");
}

function renderWorkflowPath(steps: string[], emptyText: string): string {
  if (steps.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="path">${steps
    .map((step, index) => `${index > 0 ? `<span class="arrow">→</span>` : ""}<span class="node">${escapeHtml(step)}</span>`)
    .join("")}</div>`;
}

function renderTimeline(items: Array<{ title: string; body: string; meta?: string }>, emptyText: string): string {
  if (items.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="timeline">${items
    .map((item, index) => `<div class="step"><div class="dot">${index + 1}</div><div><strong>${escapeHtml(item.title)}</strong><div class="muted">${escapeHtml(item.body)}</div>${item.meta ? `<div class="muted">${escapeHtml(item.meta)}</div>` : ""}</div></div>`)
    .join("")}</div>`;
}

function renderPills(items: string[], emptyText: string, tone: "positive" | "negative" | "neutral" = "positive"): string {
  if (items.length === 0) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  const cls = tone === "positive" ? "" : ` ${tone}`;
  return items.map((item) => `<span class="delta-pill${cls}">${escapeHtml(item)}</span>`).join("");
}

function signedDelta(value: number, digits = 0): string {
  const fixed = digits > 0 ? value.toFixed(digits) : String(Math.round(value));
  if (value > 0) return `+${fixed}`;
  return fixed;
}

function buildSkillChanges(
  currentCounts: Record<string, number>,
  previousCounts: Record<string, number>,
  limit = 6
): Array<{ name: string; current: number; previous: number; delta: number; trend: "new" | "up" | "down" | "stable" }> {
  return [...new Set([...Object.keys(currentCounts), ...Object.keys(previousCounts)])]
    .map((name) => {
      const current = currentCounts[name] ?? 0;
      const previous = previousCounts[name] ?? 0;
      const delta = current - previous;
      const trend: "new" | "up" | "down" | "stable" =
        previous === 0 && current > 0
          ? "new"
          : delta > 0
            ? "up"
            : delta < 0
              ? "down"
              : "stable";
      return { name, current, previous, delta, trend };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function countByNames(record: Record<string, number>, names: string[]): number {
  return names.reduce((sum, name) => sum + (record[name] ?? 0), 0);
}

function topDomainInfo(counts: Record<string, number>): { name: string | null; count: number } {
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? { name: top[0], count: top[1] } : { name: null, count: 0 };
}

function derivePersonalityTags(input: {
  currentSkillCounts: Record<string, number>;
  previousSkillCounts: Record<string, number>;
  currentDomainCounts: Record<string, number>;
  previousDomainCounts: Record<string, number>;
  currentQuality: Stats["quality_metrics"];
  previousQuality: Stats["quality_metrics"];
  sampleCount: number;
}): string[] {
  if (input.sampleCount === 0) return [];
  const tags: string[] = [];
  const workflowDelta = input.currentQuality.workflow_confidence - input.previousQuality.workflow_confidence;
  const scoreDelta = input.currentQuality.behavior_score - input.previousQuality.behavior_score;
  const staleDelta = input.currentQuality.stale_risk - input.previousQuality.stale_risk;
  const productSignals = ["PRD分析", "UI生成", "架构设计", "需求分析", "用户分析", "原型设计", "演示", "推广"];
  const engineeringSignals = ["代码分析", "代码生成", "Debug", "性能优化"];
  const expressionSignals = ["选题分析", "大纲生成", "草稿生成", "口播", "分镜", "页面", "图片", "发布"];
  const productDelta = countByNames(input.currentSkillCounts, productSignals) - countByNames(input.previousSkillCounts, productSignals);
  const engineeringDelta = countByNames(input.currentSkillCounts, engineeringSignals) - countByNames(input.previousSkillCounts, engineeringSignals);
  const expressionDelta = countByNames(input.currentSkillCounts, expressionSignals) - countByNames(input.previousSkillCounts, expressionSignals);
  const currentTopDomain = topDomainInfo(input.currentDomainCounts).name;
  const previousTopDomain = topDomainInfo(input.previousDomainCounts).name;

  if (workflowDelta >= 0.08 || scoreDelta >= 8) tags.push("更稳定");
  if (!tags.includes("更稳定") && (workflowDelta <= -0.08 || currentTopDomain !== previousTopDomain)) tags.push("更发散");
  if (productDelta > 0 || currentTopDomain === "product") tags.push("更产品化");
  if (engineeringDelta > 0 || currentTopDomain === "coding") tags.push("更工程化");
  if (expressionDelta > 0 || currentTopDomain === "writing" || currentTopDomain === "content") tags.push("更表达型");
  if (staleDelta < 0 || (workflowDelta > 0 && input.currentQuality.stale_risk <= input.previousQuality.stale_risk)) {
    tags.push("更安全保守");
  }
  return [...new Set(tags)].slice(0, 4);
}

function buildEvolutionSummary(input: {
  sampleCount: number;
  previousSampleCount: number;
  currentQuality: Stats["quality_metrics"];
  previousQuality: Stats["quality_metrics"];
  domainShift: { current: string | null; previous: string | null; changed: boolean; signal: string };
  skillChanges: Array<{ name: string; current: number; previous: number; delta: number; trend: "new" | "up" | "down" | "stable" }>;
  tags: string[];
}): { headline: string; narrative: string[] } {
  if (input.sampleCount === 0) {
    return {
      headline: "今年的生日资产还在学习期，先积累真实样本。",
      narrative: [
        "当前周期没有足够的真实 session，NMS 只保留北极星和安全边界。",
        "在没有证据时，不判断人格变化，也不编造技能频率。",
        "先继续 ingest，再让 /nms-auto 继承生日资产。"
      ]
    };
  }
  const workflowDelta = input.currentQuality.workflow_confidence - input.previousQuality.workflow_confidence;
  const scoreDelta = input.currentQuality.behavior_score - input.previousQuality.behavior_score;
  const staleDelta = input.currentQuality.stale_risk - input.previousQuality.stale_risk;
  const strongestSkillMove = input.skillChanges.find((item) => item.delta !== 0);
  const headline =
    workflowDelta >= 0.08 && scoreDelta >= 8
      ? "这一岁，你的工作方式明显更稳，也更适合被 Agent 继承。"
      : workflowDelta <= -0.08
        ? "这一岁，你的工作方式变得更分散，适合先收敛主流程。"
        : input.domainShift.changed
          ? `这一岁，你的重心从 ${input.domainShift.previous ?? "未知领域"} 转向了 ${input.domainShift.current ?? "未知领域"}。`
          : "这一岁，NMS 观察到你在延续一条正在成形的工作方式。";
  return {
    headline,
    narrative: [
      `样本变化：${input.previousSampleCount} -> ${input.sampleCount}，Behavior Score ${signedDelta(scoreDelta)}，Workflow Confidence ${signedDelta(workflowDelta * 100, 1)}pt。`,
      input.domainShift.signal,
      strongestSkillMove
        ? `最明显的技能变化是 ${strongestSkillMove.name}（${signedDelta(strongestSkillMove.delta)}）。`
        : "本周期没有明显的技能涨落，说明行为重心相对稳定。",
      staleDelta === 0
        ? "技能陈旧风险基本持平。"
        : `技能陈旧风险 ${signedDelta(staleDelta)}pt，${staleDelta < 0 ? "说明近期样本更鲜活。" : "说明需要补最近真实任务。"}`
    ].concat(input.tags.length > 0 ? [`当前可读到的变化标签：${input.tags.join("、")}。`] : [])
  };
}

function buildEvolutionLanes(input: {
  topWorkflow: string | undefined;
  personalityTags: string[];
  skillChanges: Array<{ name: string; current: number; previous: number; delta: number; trend: "new" | "up" | "down" | "stable" }>;
  currentQuality: Stats["quality_metrics"];
  currentTopDomain: string | null;
}): { inherit_keep: string[]; retire_stop: string[]; new_growth: string[] } {
  const inheritKeep = [
    input.topWorkflow
      ? `保留当前主 workflow：${input.topWorkflow}`
      : "保留“先看真实样本、再决定执行”的工作纪律。",
    "保留真实 .nms 数据优先，不编造结论。"
  ];
  if (input.personalityTags.length > 0) inheritKeep.push(`保留当前强势倾向：${input.personalityTags.join("、")}`);

  const decline = input.skillChanges.filter((item) => item.delta < 0).slice(0, 2);
  const retireStop = [
    input.currentQuality.stale_risk >= 60
      ? "停止依赖陈旧样本做强判断，先补最近真实任务。"
      : "停止把偶发任务误当成长期偏好。",
    ...decline.map((item) => `减少对 ${item.name} 的惯性依赖，重新验证它是否仍是主线。`)
  ].slice(0, 3);

  const growth = input.skillChanges.filter((item) => item.trend === "new" || item.delta > 0).slice(0, 3);
  const newGrowth = growth.length > 0
    ? growth.map((item) => `把 ${item.name} 发展成下一岁的稳定资产。`)
    : [
        input.currentTopDomain
          ? `围绕 ${input.currentTopDomain} 继续沉淀可复用工作流。`
          : "先完成至少 5 条真实 ingest，再谈长期拓展。"
      ];

  return { inherit_keep: inheritKeep, retire_stop: retireStop, new_growth: newGrowth };
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
          `Targets: ${context.birthday_memory.next_year_targets.join(", ") || "(none)"}`,
          `Tags: ${context.birthday_memory.personality_tags.join(", ") || "(none)"}`,
          `Evolution: ${context.birthday_memory.evolution_summary.headline}`,
          `Risks: ${context.birthday_memory.risks_to_watch.join(", ") || "(none)"}`
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
      domain_packs: storage.loadDomainPacks().length,
      audit_records: countFiles(path.join(storage.root, "audit"), ".jsonl"),
      error_records: countFiles(path.join(storage.root, "artifacts", "errors"), ".json"),
      inbox_pending: countDirectFiles(path.join(storage.root, "inbox"), ".json")
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
    `facts=events:${payload.facts.event_files}, sessions:${payload.facts.session_files}, artifacts:${payload.facts.artifact_records}, domains:${payload.facts.domain_packs}, audits:${payload.facts.audit_records}, errors:${payload.facts.error_records}, inbox:${payload.facts.inbox_pending}`,
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

export function guardCommand(
  files: string[],
  format: "human" | "json" = "human",
  policyProfile: PolicyProfileName = "normal"
): string {
  const guard = files.length === 0
    ? { ok: false, reason: "No files provided for write-scope check." }
    : validateWriteScope(files, DEFAULT_CONFIG, policyProfile);
  const policy = resolvePolicyProfile(DEFAULT_CONFIG, policyProfile);
  const payload = {
    ok: guard.ok,
    files,
    reason: guard.reason ?? "All files are inside allowed roots and file types.",
    policy_profile: policyProfile,
    secret_hits: guard.secret_hits ?? [],
    policy: {
      allowed_roots: policy.allowed_roots,
      core_explicit_whitelist: policy.core_explicit_whitelist,
      allowed_file_kinds: ["ui", "new", "test"]
    }
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "== NMS Guard ==",
    `decision=${payload.ok ? "ALLOW" : "BLOCK"}`,
    `policy_profile=${policyProfile}`,
    `reason=${payload.reason}`,
    `files=${files.join(", ") || "(none)"}`,
    ...(payload.secret_hits.length > 0 ? [`secret_hits=${payload.secret_hits.map((hit) => `${hit.rule}:${hit.file}`).join(", ")}`] : []),
    `allowed_roots=${payload.policy.allowed_roots.join(", ")}`
  ].join("\n");
}

export function guardPendingCommand(
  format: "human" | "json" = "human",
  policyProfile: PolicyProfileName = "normal"
): string {
  const files = pendingGitFiles();
  if (files.length === 0) {
    const policy = resolvePolicyProfile(DEFAULT_CONFIG, policyProfile);
    const payload = {
      ok: true,
      files,
      reason: "No pending git files detected. Nothing needs write-scope approval right now.",
      policy_profile: policyProfile,
      policy: {
        allowed_roots: policy.allowed_roots,
        core_explicit_whitelist: policy.core_explicit_whitelist,
        allowed_file_kinds: ["ui", "new", "test"]
      }
    };
    if (format === "json") return JSON.stringify(payload, null, 2);
    return [
      "== NMS Guard ==",
      "decision=ALLOW",
      `policy_profile=${policyProfile}`,
      `reason=${payload.reason}`,
      "files=(none)",
      `allowed_roots=${payload.policy.allowed_roots.join(", ")}`
    ].join("\n");
  }
  return guardCommand(files, format, policyProfile);
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
  policy_profile?: PolicyProfileName;
  secret_hits?: Array<{ file: string; rule: string; summary: string }>;
};

function decisionFromAuto(guard: GuardPayload, night: NightReport | null): "READY_FOR_REVIEW" | "BLOCKED_BY_POLICY" | "NEEDS_ATTENTION" {
  if (!guard.ok) return "BLOCKED_BY_POLICY";
  if (night?.final_state === State.GATE || night?.final_state === State.COMMIT) return "READY_FOR_REVIEW";
  return "NEEDS_ATTENTION";
}

export function autoCommand(format: "human" | "json" = "human"): string {
  const storage = new JsonStorage();
  const policyProfile: PolicyProfileName = "strict";
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
  const guard = JSON.parse(guardPendingCommand("json", policyProfile)) as GuardPayload;
  const night = guard.ok
    ? JSON.parse(nightCommand({ dryRun: true, explain: true, task, policyProfile })) as NightReport
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
    policy_profile: policyProfile,
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
      audit_artifact: null as string | null,
      explain_chain: night?.explain_chain ?? [],
      failure: night?.failure ?? (!guard.ok
        ? {
            code: "POLICY_BLOCK",
            failure_reason: guard.reason,
            recovery_hint: "Resolve pending files outside the allowed write scope before auto execution.",
            next_safe_command: "nms guard --format json",
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

  const autoArtifactPath = path.join(storage.root, "artifacts", "auto", `auto-${Date.now()}.json`);
  storage.recordArtifact({
    type: "context",
    path: relativeToNmsRoot(storage, autoArtifactPath),
    source_data_hash: sha256(JSON.stringify(payload)),
    real_data_only: true,
    metadata: { kind: "auto", policy_profile: policyProfile, decision }
  });
  const autoAuditRef = recordCommandAudit(storage, {
    command: "auto",
    triggeredBy: "/nms-auto",
    policyProfile,
    inputSummary: task,
    fileScope: guard.files,
    gateResult: decision,
    artifactPaths: [relativeToNmsRoot(storage, autoArtifactPath), ...(birthdayMemory ? [birthdayMemory.latest_capsule_ref] : [])],
    notes: [gateReason]
  });
  payload.gate.audit_artifact = autoAuditRef;
  writeJsonArtifact(autoArtifactPath, payload);

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
    ...(birthdayMemory ? [`Birthday Evolution: ${birthdayMemory.evolution_summary.headline}`] : []),
    ...(birthdayMemory ? [`Birthday Tags: ${birthdayMemory.personality_tags.join(", ") || "(none)"}`] : []),
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
  const warnings: string[] = [];
  if (db.sessions.length === 0) warnings.push("当前没有真实会话样本，页面只展示学习态，不做偏好推断。");
  if (quality.stale_risk >= 60) warnings.push("陈旧风险较高，建议先补最近真实任务，再让 Agent 继承这些信号。");
  const html = visualShell({
    theme: "flow",
    title: "NMS Flow Dashboard",
    eyebrow: "No More Skill · NMS 行为驾驶舱 · Live Behavior Cockpit",
    headline: "你的 Agent 工作方式，正在被真实数据驯化。",
    subtitle: "这个驾驶舱只读取本地 .nms 真实数据，把领域分布、技能频率、workflow 路径和系统健康度放到同一张操作台上。",
    metrics: [
      { label: "Behavior Score", value: String(quality.behavior_score), note: "行为稳定度" },
      { label: "Workflow Confidence", value: `${Math.round(quality.workflow_confidence * 100)}%`, note: "主流程置信度" },
      { label: "Session Velocity(7d)", value: String(quality.session_velocity_7d), note: "近 7 天活跃度" },
      { label: "Streak Days", value: String(quality.streak_days), note: "连续学习天数" }
    ],
    body: `
      ${warnings.length > 0 ? `<section class="card"><div class="callout warning"><strong>当前提醒</strong><div class="muted">${warnings.map(escapeHtml).join(" · ")}</div></div></section>` : ""}
      <section class="grid-2">
        <div class="card">
          <h2>Domain Mix</h2>
          <p class="muted">最近被 NMS 学到的工作领域重心。</p>
          ${renderBarRows(domainEntries.map(([name, count]) => ({ label: name, value: count })), "暂无领域数据。")}
        </div>
        <div class="card">
          <h2>Skill Frequency</h2>
          <p class="muted">不是 prompt 收藏，而是真实技能使用频率。</p>
          ${renderBarRows(topSkills.map(([name, count]) => ({ label: name, value: count })), "暂无技能频率数据。")}
        </div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>Main Workflow Path</h2>
          <p class="muted">当前最常被复用的工作路径。</p>
          ${renderWorkflowPath(topWorkflow, "暂无稳定 workflow。")}
        </div>
        <div class="card">
          <h2>Top Workflow Edges</h2>
          <p class="muted">最常见的步骤跳转边，反映真实流程连接。</p>
          ${renderTimeline(
            edgeEntries.map((edge) => ({
              title: `${edge.from} → ${edge.to}`,
              body: `出现 ${edge.count} 次`
            })),
            "暂无 workflow 边数据。"
          )}
        </div>
      </section>
      <section class="card">
        <h2>Interpretation Layer</h2>
        <div class="grid-3">
          <div class="lane keep">
            <h3>Keep</h3>
            <div class="list">
              <div class="item">优先复用主 workflow，再决定是否拓展新路径。</div>
              <div class="item">把高频技能视作 Agent 的默认熟悉区。</div>
            </div>
          </div>
          <div class="lane stop">
            <h3>Watch</h3>
            <div class="list">
              <div class="item">不要把空样本或旧样本误当成稳定偏好。</div>
              <div class="item">不要绕过 <code>nms flow --format json</code> 的原始证据层。</div>
            </div>
          </div>
          <div class="lane new">
            <h3>Next</h3>
            <div class="list">
              <div class="item">让新任务继续沉淀到 <code>.nms</code>，提高 workflow confidence。</div>
              <div class="item">若要执行任务，走 <code>/nms-auto</code> 而不是直接 apply。</div>
            </div>
          </div>
        </div>
        <div class="source">真实数据来源：<code>.nms/data.json</code>、<code>.nms/sessions</code>、<code>.nms/derived</code>。机器可读输出：<code>nms flow --format json</code>。</div>
      </section>`
  });

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
  policyProfile?: PolicyProfileName;
}): string {
  if (options.resume) return resumeNightRunCommand(options.resume);
  const started = performance.now();
  const policyProfile = options.policyProfile ?? "strict";
  const apply = Boolean(options.apply);
  const dryRun = apply ? Boolean(options.dryRun) : options.dryRun ?? true;
  if (apply && options.task && !options.taskFile) {
    return JSON.stringify(
      {
        dry_run: false,
        policy_profile: policyProfile,
        final_state: State.ROLLBACK,
        retries: 0,
        logs: ["Auto-planned --task is dry-run only. Provide --task-file for apply."],
        failure: {
          code: "CONFIG_ERROR",
          failure_reason: "Apply requires explicit task-file",
          recovery_hint: "Run dry-run first, then create a reviewed task-file for --apply.",
          next_safe_command: "nms night --dry-run --task \"your task\"",
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
  let plannerInput: PlannerOutput | undefined;
  try {
    plannerInput = options.taskFile
      ? readPlannerInput(options.taskFile)
      : autoTask
        ? buildPlannerFromTask(autoTask, storage)
        : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const errorArtifact = storage.recordErrorArtifact({
      kind: "night-config",
      source: options.taskFile ?? "task-file",
      reason,
      recovery_hint: "Verify that the task file exists and contains valid planner JSON.",
      next_safe_command: "nms doctor",
      input_summary: options.taskFile ?? "(missing task-file)"
    });
    const payload = {
      dry_run: !apply,
      policy_profile: policyProfile,
      final_state: State.ROLLBACK,
      retries: 0,
      logs: [reason],
      failure: {
        code: "CONFIG_ERROR",
        failure_reason: reason,
        recovery_hint: "Verify that the task file exists and contains valid planner JSON.",
        next_safe_command: "nms doctor",
        retry_count: 0,
        non_retryable: true,
        state_at_failure: State.PLAN,
        artifacts_ref: relativeToNmsRoot(storage, errorArtifact)
      }
    };
    const auditRef = recordCommandAudit(storage, {
      command: "night",
      triggeredBy: "/nms-night",
      policyProfile,
      inputSummary: options.taskFile ?? "(missing task-file)",
      fileScope: options.taskFile ? [options.taskFile] : [],
      gateResult: "CONFIG_ERROR",
      artifactPaths: [relativeToNmsRoot(storage, errorArtifact)],
      notes: [reason]
    });
    return JSON.stringify({ ...payload, audit_artifact: auditRef }, null, 2);
  }
  const report = runNightHarness({
    dryRun,
    apply,
    policyProfile,
    explain: Boolean(options.explain),
    plannerInput,
    timeBudgetMinutes: options.timeBudget ?? 5
  });
  if (autoTask && !options.taskFile) {
    report.logs.push("Auto planner generated from route defaults or --task. Review and persist a task-file before apply.");
  }
  storage.trackPerf("night_ms", Number((performance.now() - started).toFixed(2)));
  const artifactPath = storage.recordNightRun(report);
  const auditRef = recordCommandAudit(storage, {
    command: "night",
    triggeredBy: "/nms-night",
    policyProfile,
    inputSummary: plannerInput?.task ?? "(missing task)",
    fileScope: plannerInput?.files ?? [],
    gateResult: report.final_state,
    artifactPaths: [relativeToNmsRoot(storage, artifactPath)],
    notes: report.failure
      ? [report.failure.failure_reason, report.failure.next_safe_command]
      : report.logs.slice(-2)
  });
  report.audit_artifact = auditRef;
  writeJsonArtifact(artifactPath, report);
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

export function hostsCommand(
  format: "human" | "json" = "human",
  options?: { probe?: boolean; writeCommands?: boolean; homeDir?: string }
): string {
  const written = options?.writeCommands
    ? writeHostCommandFiles({ homeDir: options.homeDir })
    : [];
  const report = detectHostIntegrations({
    homeDir: options?.homeDir,
    probeExecutables: options?.probe ?? false
  });
  const payload = {
    ...report,
    written_command_files: written
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    written.length > 0
      ? `Command files written: ${written.map((item) => `${item.host}:${item.path}`).join(", ")}`
      : undefined,
    formatHostReport(report)
  ].filter(Boolean).join("\n");
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
    "audit",
    "inbox",
    path.join("artifacts", "artifacts.json"),
    path.join("artifacts", "auto"),
    path.join("artifacts", "errors"),
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
  const hostReport = detectHostIntegrations();
  for (const host of hostReport.hosts) {
    checks.push({
      check: `Host ${host.label}`,
      status: host.status === "ready" ? "PASS" : "WARN",
      detail: `${host.status}; invoke=${host.invocation[0]}; fix=${host.fix_hint}`
    });
  }
  checks.push({
    check: "Policy Profiles",
    status: "PASS",
    detail: Object.keys(DEFAULT_CONFIG.harness.policy_profiles).join(", ")
  });
  checks.push({
    check: "Audit Trail",
    status: countFiles(path.join(storage.root, "audit"), ".jsonl") > 0 ? "PASS" : "WARN",
    detail: `audit_files=${countFiles(path.join(storage.root, "audit"), ".jsonl")}, error_artifacts=${countFiles(path.join(storage.root, "artifacts", "errors"), ".json")}`
  });

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
    const reportRef = path.relative(storage.root, reportPath).replaceAll("\\", "/");
    storage.recordArtifact({
      type: "report",
      path: reportRef,
      source_data_hash: sourceHash,
      real_data_only: options.realOnly ?? true,
      metadata: { format: "json", period, template }
    });
    storage.recordEvent("REPORT_GENERATED", reportRef, sourceHash);
    recordCommandAudit(storage, {
      command: "report",
      triggeredBy: "/nms-report",
      policyProfile: "normal",
      inputSummary: `report ${period} ${template}`,
      fileScope: [],
      gateResult: reportSessions.length === 0 ? "EMPTY_STATE" : "OK",
      artifactPaths: [reportRef],
      notes: [`sample_count=${reportSessions.length}`]
    });
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
    const mainWorkflowSteps = topWorkflows[0]?.[0].split(" -> ") ?? [];
    const html = visualShell({
      theme: "report",
      title: "NMS Agent Report",
      eyebrow: "No More Skill · Real Behavior Report",
      headline: "你的工作方式，正在变成 Agent 可执行的操作系统。",
      subtitle: `周期：${period}。本报告只读取本地 .nms 真实数据，把领域、技能、workflow、风险和可执行建议整理成一张可以展示的行为证据板。`,
      metrics: [
        { label: "真实样本", value: String(reportSessions.length), note: `周期 ${period}` },
        { label: "Behavior Score", value: String(quality.behavior_score), note: "稳定度" },
        { label: "Workflow Confidence", value: `${Math.round(quality.workflow_confidence * 100)}%`, note: "主流程置信度" },
        { label: "Stale Risk", value: `${quality.stale_risk}%`, note: "样本陈旧风险" }
      ],
      body: `
        ${reportSessions.length === 0 ? `<section class="card"><div class="callout warning"><strong>样本不足</strong><div class="muted">当前周期没有足够真实 session。请先运行 <code>nms ingest --input input.json</code>，再生成报告。</div></div></section>` : ""}
        <section class="grid-2">
          <div class="card">
            <h2>领域分布 / Domain Mix</h2>
            <p class="muted">用户最近把精力放在哪些领域。</p>
            ${renderBarRows(topDomains.map(([name, count]) => ({ label: name, value: count })), "暂无领域数据。")}
          </div>
          <div class="card">
            <h2>Skill 使用频率</h2>
            <p class="muted">只统计真实会话里的 skill 使用频率。</p>
            ${renderBarRows(topSkills.map(([name, count]) => ({ label: name, value: count })), "暂无 skill 频率数据。")}
            ${fs.existsSync(skillImg) ? `<img src="${path.relative(reportDir, skillImg).replaceAll("\\", "/")}" alt="skill frequency" />` : ""}
          </div>
        </section>
        <section class="grid-2">
          <div class="card">
            <h2>Workflow Path</h2>
            <p class="muted">最稳定的主路径，适合作为 Agent 默认工作流。</p>
            ${renderWorkflowPath(mainWorkflowSteps, "暂无主 workflow。")}
            <div style="margin-top:14px">${renderPills(workflowEdges.map((edge) => `${edge.from} → ${edge.to} · ${edge.count}`), "暂无 workflow 转移边。", "neutral")}</div>
          </div>
          <div class="card">
            <h2>Workflow 排名与转移边</h2>
            <p class="muted">当前周期被重复验证过的流程排名。</p>
            ${renderTimeline(
              topWorkflows.map(([wf, count]) => ({
                title: wf,
                body: `出现 ${count} 次`
              })),
              "暂无可稳定复现的 workflow。"
            )}
            ${fs.existsSync(progressImg) ? `<img src="${path.relative(reportDir, progressImg).replaceAll("\\", "/")}" alt="work progress" />` : ""}
          </div>
        </section>
        <section class="grid-2">
          <div class="card">
            <h2>Style & Evolution</h2>
            <div class="list">
              <div class="item">当前风格：${escapeHtml(db.user_profile.style)}</div>
              <div class="item">Top Skills：${db.user_profile.top_skills.map(escapeHtml).join(", ") || "暂无"}</div>
              <div class="item">Top Workflows：${db.user_profile.top_workflows.map(escapeHtml).join(", ") || "暂无"}</div>
            </div>
            ${fs.existsSync(personaImg) ? `<img src="${path.relative(reportDir, personaImg).replaceAll("\\", "/")}" alt="persona evolution" />` : ""}
          </div>
          <div class="card">
            <h2>Risk Panel</h2>
            ${renderTimeline(
              [
                { title: "样本新鲜度", body: quality.stale_risk >= 60 ? "当前偏陈旧，先补最近真实任务。" : "近期样本可用。" },
                { title: "流程可信度", body: quality.workflow_confidence < 0.5 ? "保持建议态，不要当硬规则。" : "可以作为温和偏好继承。" },
                { title: "系统健康", body: imageNotes.join("；") }
              ],
              "暂无风险信息。"
            )}
          </div>
        </section>
        ${reportTemplateHtml(template, topDomains, topWorkflows)}
        <section class="card">
          <h2>下一步建议</h2>
          ${renderTimeline(
            [
              { title: "继续采集真实工作流", body: "next: nms ingest --input input.json" },
              { title: "给 Agent 读取上下文", body: "next: nms context --task \\\"你的任务\\\" --format json" },
              { title: "先 dry-run 再执行", body: "next: nms night --dry-run --explain --task-file task.json" }
            ],
            "暂无建议。"
          )}
          <div class="source">真实数据来源：<code>.nms/data.json</code>、<code>.nms/sessions</code>、<code>.nms/derived</code>。样本不足时只展示学习态，不补任何虚构 skill、workflow 或趋势。</div>
        </section>`
    });
    const reportPath = path.join(reportDir, "report.html");
    fs.writeFileSync(reportPath, html, "utf8");
    const reportRef = path.relative(storage.root, reportPath).replaceAll("\\", "/");
    storage.recordArtifact({
      type: "report",
      path: reportRef,
      source_data_hash: sourceHash,
      real_data_only: options.realOnly ?? true,
      metadata: { format: "html", period, template }
    });
    storage.recordEvent("REPORT_GENERATED", reportRef, sourceHash);
    recordCommandAudit(storage, {
      command: "report",
      triggeredBy: "/nms-report",
      policyProfile: "normal",
      inputSummary: `report ${period} ${template}`,
      fileScope: [],
      gateResult: reportSessions.length === 0 ? "EMPTY_STATE" : "OK",
      artifactPaths: [reportRef],
      notes: [`sample_count=${reportSessions.length}`]
    });
    return reportPath;
  }

  const reportPath = path.join(reportDir, "report.md");
  fs.writeFileSync(reportPath, reportMd, "utf8");
  const reportRef = path.relative(storage.root, reportPath).replaceAll("\\", "/");
  storage.recordArtifact({
    type: "report",
    path: reportRef,
    source_data_hash: sourceHash,
    real_data_only: options?.realOnly ?? true,
    metadata: { format: "md", period, template }
  });
  storage.recordEvent("REPORT_GENERATED", reportRef, sourceHash);
  recordCommandAudit(storage, {
    command: "report",
    triggeredBy: "/nms-report",
    policyProfile: "normal",
    inputSummary: `report ${period} ${template}`,
    fileScope: [],
    gateResult: reportSessions.length === 0 ? "EMPTY_STATE" : "OK",
    artifactPaths: [reportRef],
    notes: [`sample_count=${reportSessions.length}`]
  });
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
  const skillChanges = buildSkillChanges(currentCounts.skillCounts, previousCounts.skillCounts, 8);
  const currentTopDomainInfo = topDomainInfo(currentCounts.domainCounts);
  const previousTopDomainInfo = topDomainInfo(previousCounts.domainCounts);
  const domainShift = {
    current: currentTopDomainInfo.name,
    previous: previousTopDomainInfo.name,
    changed: currentTopDomainInfo.name !== previousTopDomainInfo.name,
    signal:
      currentSessions.length === 0
        ? "样本不足，暂不判断领域迁移。"
        : currentTopDomainInfo.name === previousTopDomainInfo.name
          ? `领域重心仍然停留在 ${currentTopDomainInfo.name ?? "未知领域"}。`
          : `领域重心从 ${previousTopDomainInfo.name ?? "未知领域"} 转向了 ${currentTopDomainInfo.name ?? "未知领域"}。`
  };
  const behaviorDelta = {
    sample_count_delta: currentSessions.length - previousSessions.length,
    behavior_score_delta: currentQuality.behavior_score - previousQuality.behavior_score,
    workflow_confidence_delta: Number((currentQuality.workflow_confidence - previousQuality.workflow_confidence).toFixed(3)),
    stale_risk_delta: currentQuality.stale_risk - previousQuality.stale_risk,
    domain_shift: domainShift,
    skill_changes: skillChanges
  };
  const previousSkillNames = new Set(Object.keys(previousCounts.skillCounts));
  const emergingSkills = topSkills
    .filter(([name, count]) => !previousSkillNames.has(name) || count > (previousCounts.skillCounts[name] ?? 0))
    .slice(0, 5)
    .map(([name]) => name);
  const stableWorkflows = topEntries(currentCounts.workflowCounts, 5).map(([name]) => name);
  const topDomains = topEntries(currentCounts.domainCounts, 4);
  const topDomain = topDomains[0]?.[0];
  const topWorkflow = stableWorkflows[0];
  const personalityTags = derivePersonalityTags({
    currentSkillCounts: currentCounts.skillCounts,
    previousSkillCounts: previousCounts.skillCounts,
    currentDomainCounts: currentCounts.domainCounts,
    previousDomainCounts: previousCounts.domainCounts,
    currentQuality,
    previousQuality,
    sampleCount: currentSessions.length
  });
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
  const evolutionSummary = buildEvolutionSummary({
    sampleCount: currentSessions.length,
    previousSampleCount: previousSessions.length,
    currentQuality,
    previousQuality,
    domainShift,
    skillChanges,
    tags: personalityTags
  });
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
  const evolutionLanes = buildEvolutionLanes({
    topWorkflow,
    personalityTags,
    skillChanges,
    currentQuality,
    currentTopDomain: currentTopDomainInfo.name
  });
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
    schema_version: 2,
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
    personality_tags: personalityTags,
    evolution_summary: evolutionSummary,
    behavior_delta: behaviorDelta,
    evolution_lanes: evolutionLanes,
    growth_vectors: growthVectors,
    risks_to_watch: risksToWatch,
    next_year_targets: nextYearTargets,
    agent_instructions: [
      "Read birthday_memory from nms context before personalized work.",
      "Preserve north_star unless the user explicitly changes it.",
      "Treat next_year_targets as long-term guidance, not hard requirements.",
      "Use evolution_summary, behavior_delta, and evolution_lanes as soft longitudinal hints, not absolute truth.",
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
    `必须只使用真实数据：sample_count=${capsule.sample_count}, behavior_score=${currentQuality.behavior_score}, workflow_confidence_delta=${behaviorDelta.workflow_confidence_delta}, stale_risk_delta=${behaviorDelta.stale_risk_delta}, workflows=${stableWorkflows.join(" | ") || "样本不足"}, skills=${topSkills.map(([name, count]) => `${name}:${count}`).join(" | ") || "样本不足"}, tags=${personalityTags.join(" | ") || "样本不足"}.`,
    "画面风格：未来感控制台、温暖生日仪式、Agent 记忆胶囊、中文标题“NMS Birthday”、North Star、三栏进化资产。",
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

## Personality Tags

${personalityTags.map((item) => `- ${item}`).join("\n") || "- 暂无足够信号判断变化标签。"}

## Evolution Summary

- ${evolutionSummary.headline}
${evolutionSummary.narrative.map((item) => `- ${item}`).join("\n")}

## Behavior Delta

- Sample Delta: ${signedDelta(behaviorDelta.sample_count_delta)}
- Behavior Score Delta: ${signedDelta(behaviorDelta.behavior_score_delta)}
- Workflow Confidence Delta: ${signedDelta(behaviorDelta.workflow_confidence_delta * 100, 1)}pt
- Stale Risk Delta: ${signedDelta(behaviorDelta.stale_risk_delta)}pt
- Domain Shift: ${behaviorDelta.domain_shift.signal}
${behaviorDelta.skill_changes.map((item) => `- ${item.name}: ${item.previous} -> ${item.current} (${signedDelta(item.delta)})`).join("\n") || "- 暂无显著 skill 变化。"}

## Changed Habits

${changedHabits.map((item) => `- ${item}`).join("\n")}

## Inherit / Retire / New

### Inherit
${evolutionLanes.inherit_keep.map((item) => `- ${item}`).join("\n")}

### Retire
${evolutionLanes.retire_stop.map((item) => `- ${item}`).join("\n")}

### New
${evolutionLanes.new_growth.map((item) => `- ${item}`).join("\n")}

## Next Year Targets

${nextYearTargets.map((item) => `- ${item}`).join("\n")}

## Agent Instructions

${capsule.agent_instructions.map((item) => `- ${item}`).join("\n")}
`;
  fs.writeFileSync(mdPath, md, "utf8");

  const html = visualShell({
    theme: "birthday",
    title: "NMS Birthday Memory Capsule",
    eyebrow: "NMS Birthday · Living Agent Asset",
    headline: "每天重启，但不忘北极星。",
    subtitle: "这不是一次性的生日总结，而是一枚会被后续 Agent 读取的长期记忆资产。它记录你今年真正变成了什么、该停下什么、以及下一岁准备把什么长出来。",
    metrics: [
      { label: "本周期样本", value: String(capsule.sample_count), note: `较上周期 ${signedDelta(behaviorDelta.sample_count_delta)}` },
      { label: "Behavior Score", value: String(currentQuality.behavior_score), note: `${signedDelta(behaviorDelta.behavior_score_delta)}` },
      { label: "Workflow Confidence", value: `${Math.round(currentQuality.workflow_confidence * 100)}%`, note: `${signedDelta(behaviorDelta.workflow_confidence_delta * 100, 1)}pt` },
      { label: "Stale Risk", value: `${currentQuality.stale_risk}%`, note: `${signedDelta(behaviorDelta.stale_risk_delta)}pt` }
    ],
    body: `
      ${capsule.sample_count === 0 ? `<section class="card"><div class="callout warning"><strong>样本不足</strong><div class="muted">当前没有足够真实 session。NMS 不会编造生日画像，只会保留目标、边界和学习方向。</div></div></section>` : ""}
      <section class="card">
        <h2>North Star</h2>
        <div class="item">${escapeHtml(capsule.north_star)}</div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>Evolution Summary</h2>
          <div class="item">${escapeHtml(evolutionSummary.headline)}</div>
          ${renderTimeline(
            evolutionSummary.narrative.map((item, index) => ({
              title: `Signal ${index + 1}`,
              body: item
            })),
            "暂无进化总结。"
          )}
        </div>
        <div class="card">
          <h2>人格变化标签</h2>
          <p class="muted">只在有真实证据时打标签，不做空想人格分析。</p>
          <div>${renderPills(personalityTags, "暂无足够信号判断变化标签。")}</div>
          <div style="margin-top:14px">${renderPills(capsule.changed_habits, "暂无习惯变化提示。", "neutral")}</div>
        </div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>Behavior Delta</h2>
          ${renderTimeline(
            [
              { title: "技能变化", body: skillChanges[0] ? `${skillChanges[0].name}: ${skillChanges[0].previous} -> ${skillChanges[0].current} (${signedDelta(skillChanges[0].delta)})` : "暂无显著技能变化。" },
              { title: "Workflow 稳定度", body: `${Math.round(previousQuality.workflow_confidence * 100)}% -> ${Math.round(currentQuality.workflow_confidence * 100)}%` },
              { title: "领域重心", body: behaviorDelta.domain_shift.signal },
              { title: "陈旧风险", body: `${previousQuality.stale_risk}% -> ${currentQuality.stale_risk}%` }
            ],
            "暂无差分数据。"
          )}
        </div>
        <div class="card">
          <h2>稳定 Workflow 与新信号</h2>
          ${renderWorkflowPath(capsule.stable_workflows, "暂无稳定 workflow，先通过真实 ingest 继续学习。")}
          <div style="margin-top:14px">${renderPills(capsule.emerging_skills, "暂无新高频 skill。")}</div>
          <div class="source">领域迁移：${escapeHtml(behaviorDelta.domain_shift.signal)}</div>
        </div>
      </section>
      <section class="grid-3">
        <div class="lane keep">
          <h2>继承</h2>
          <div class="list">${capsule.evolution_lanes.inherit_keep.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
        </div>
        <div class="lane stop">
          <h2>放弃</h2>
          <div class="list">${capsule.evolution_lanes.retire_stop.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
        </div>
        <div class="lane new">
          <h2>新生</h2>
          <div class="list">${capsule.evolution_lanes.new_growth.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
        </div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>保留下来的承诺</h2>
          <div class="list">${capsule.retained_commitments.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
        </div>
        <div class="card">
          <h2>下一岁路线图</h2>
          <div class="list">${capsule.next_year_targets.map((item) => `<div class="item">${escapeHtml(item)}</div>`).join("")}</div>
        </div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>Risk Panel</h2>
          ${renderTimeline(
            capsule.risks_to_watch.map((item, index) => ({
              title: `Risk ${index + 1}`,
              body: item
            })),
            "暂无风险提醒。"
          )}
        </div>
        <div class="card">
          <h2>Agent 会继承什么</h2>
          <div class="list">${capsule.agent_instructions.map((item) => `<div class="item"><code>${escapeHtml(item)}</code></div>`).join("")}</div>
          <div class="source">Capsule: ${escapeHtml(capsule.artifacts.capsule_ref)} · Markdown: ${escapeHtml(capsule.artifacts.markdown_ref)} · HTML: ${escapeHtml(capsule.artifacts.html_report_ref)}</div>
        </div>
      </section>
      ${fs.existsSync(posterPath) ? `<section class="card"><h2>Birthday Poster</h2><img src="${path.relative(reportDir, posterPath).replaceAll("\\", "/")}" alt="birthday poster" /></section>` : ""}
      <section class="card">
        <div class="source">真实数据来源：<code>.nms/data.json</code>、<code>.nms/sessions</code>、<code>.nms/derived/birthday/latest.json</code>。生日资产会被 <code>/nms-auto</code> 作为长期提示继承，但不会覆盖安全边界。</div>
      </section>`
  });
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
  const birthdayAuditRef = recordCommandAudit(storage, {
    command: "birthday",
    triggeredBy: "/nms-birthday",
    policyProfile: "normal",
    inputSummary: `birthday period=${periodDays}`,
    fileScope: [],
    gateResult: capsule.sample_count === 0 ? "EMPTY_STATE" : "OK",
    artifactPaths: [
      capsule.artifacts.capsule_ref,
      capsule.artifacts.html_report_ref,
      capsule.artifacts.markdown_ref,
      ...(capsule.artifacts.poster_ref ? [capsule.artifacts.poster_ref] : [])
    ],
    notes: [capsule.evolution_summary.headline]
  });

  const payload = {
    generated_at: generatedAt,
    capsule,
    audit_artifact: birthdayAuditRef,
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
    `Evolution: ${capsule.evolution_summary.headline}`,
    `Tags: ${capsule.personality_tags.join(", ") || "(not enough data yet)"}`,
    `Stable Workflow: ${capsule.stable_workflows[0] ?? "(not enough data yet)"}`,
    `Next Target: ${capsule.next_year_targets[0]}`,
    `Capsule: ${capsulePath}`,
    `Report: ${htmlPath}`,
    fs.existsSync(posterPath) ? `Poster: ${posterPath}` : "Poster: not generated (use --image when image relay is configured)",
    payload.next_step
  ].join("\n");
}
