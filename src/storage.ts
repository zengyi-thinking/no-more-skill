import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AgentContext,
  ArtifactRecord,
  Database,
  NmsEvent,
  SessionRecord,
  SessionV3,
  SourceToolName,
  UserProfile
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { skillCategory } from "./hook/skillDictionary.js";

const PERF_WINDOW_SIZE = 100;

const DEFAULT_DB: Database = {
  schema_version: 3,
  sessions: [],
  stats: {
    skill_counts: {},
    workflow_counts: {},
    last_updated: new Date(0).toISOString(),
    ingest_count: 0,
    perf_windows: {
      ingest_ms: [],
      flow_ms: [],
      night_ms: [],
      max_window: PERF_WINDOW_SIZE
    },
    quality_metrics: {
      behavior_score: 0,
      workflow_confidence: 0,
      session_velocity_7d: 0,
      stale_risk: 0,
      streak_days: 0
    }
  },
  user_profile: {
    style: "unknown",
    top_skills: [],
    top_workflows: [],
    updated_at: new Date(0).toISOString()
  }
};

const DEFAULT_DOMAINS: Record<string, unknown>[] = [
  {
    domain: "coding",
    skills: {
      "分析类": ["PRD分析", "代码分析"],
      "生成类": ["UI生成", "代码生成"],
      "优化类": ["Prompt优化", "性能优化"],
      "调试类": ["Debug"],
      "设计类": ["架构设计"]
    },
    workflow_templates: [["PRD分析", "代码分析", "代码生成", "Debug"]],
    style_signals: [{ name: "结构化推进", patterns: ["先", "再", "最后", "测试"] }]
  },
  {
    domain: "writing",
    skills: {
      "分析类": ["选题分析", "读者分析"],
      "生成类": ["大纲生成", "草稿生成"],
      "优化类": ["标题优化", "结构优化"],
      "发布类": ["平台适配", "发布复盘"]
    },
    workflow_templates: [["选题分析", "大纲生成", "草稿生成", "结构优化", "发布复盘"]],
    style_signals: [{ name: "结构化表达", patterns: ["先", "再", "最后", "分步骤"] }]
  },
  {
    domain: "research",
    skills: {
      "分析类": ["问题定义", "资料收集"],
      "验证类": ["交叉验证", "来源评估"],
      "生成类": ["结论归纳", "研究报告"]
    },
    workflow_templates: [["问题定义", "资料收集", "交叉验证", "结论归纳"]],
    style_signals: [{ name: "证据优先", patterns: ["来源", "证据", "验证", "引用"] }]
  },
  {
    domain: "learning",
    skills: {
      "规划类": ["学习目标", "资料选择"],
      "执行类": ["练习", "反馈"],
      "复盘类": ["学习复盘"]
    },
    workflow_templates: [["学习目标", "资料选择", "练习", "反馈", "学习复盘"]],
    style_signals: [{ name: "迭代学习", patterns: ["练习", "反馈", "复盘"] }]
  },
  {
    domain: "product",
    skills: {
      "分析类": ["需求分析", "用户分析"],
      "设计类": ["原型设计", "文案设计"],
      "发布类": ["演示", "推广"]
    },
    workflow_templates: [["需求分析", "用户分析", "原型设计", "演示", "推广"]],
    style_signals: [{ name: "产品交付", patterns: ["用户", "场景", "推广", "演示"] }]
  },
  {
    domain: "content",
    skills: {
      "创作类": ["口播", "分镜"],
      "视觉类": ["页面", "图片"],
      "发布类": ["发布", "复盘"]
    },
    workflow_templates: [["口播", "分镜", "页面", "图片", "发布"]],
    style_signals: [{ name: "内容生产", patterns: ["口播", "分镜", "视频", "发布"] }]
  }
];

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function redactText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=[REDACTED]");
}

function compactEvidence(text: string, skill: string): string[] {
  const safe = redactText(text);
  const idx = safe.indexOf(skill);
  if (idx < 0) return [];
  const start = Math.max(0, idx - 24);
  const end = Math.min(safe.length, idx + skill.length + 24);
  return [safe.slice(start, end)];
}

function workflowConfidence(session: SessionRecord): number {
  if (session.workflow.length === 0) return 0;
  return Number(Math.min(1, session.workflow.length / Math.max(1, session.skills_used.length)).toFixed(3));
}

function detectDomain(session: SessionRecord): string {
  const text = `${session.compressed_text}\n${session.conversation}`.toLowerCase();
  if (/写作|文章|标题|大纲|草稿|发布/.test(text)) return "writing";
  if (/研究|资料|来源|引用|验证|论文/.test(text)) return "research";
  if (/学习|课程|练习|复盘|掌握/.test(text)) return "learning";
  if (/产品|用户|需求|原型|推广|演示/.test(text)) return "product";
  if (/口播|分镜|视频|图片|内容/.test(text)) return "content";
  return "coding";
}

function relativeToRoot(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function pushWindowMetric(target: number[], value: number, max: number): number[] {
  const next = [...target, value];
  return next.length <= max ? next : next.slice(next.length - max);
}

function computeStatsFromSessions(sessions: SessionRecord[]): Pick<Database["stats"], "skill_counts" | "workflow_counts"> {
  const skill_counts: Record<string, number> = {};
  const workflow_counts: Record<string, number> = {};
  for (const s of sessions) {
    for (const skill of s.skills_used) skill_counts[skill] = (skill_counts[skill] ?? 0) + 1;
    const wfKey = s.workflow.join(" -> ");
    if (wfKey) workflow_counts[wfKey] = (workflow_counts[wfKey] ?? 0) + 1;
  }
  return { skill_counts, workflow_counts };
}

function computeQualityMetrics(db: Database): Database["stats"]["quality_metrics"] {
  const sessions = db.sessions;
  const total = sessions.length;
  if (total === 0) {
    return {
      behavior_score: 0,
      workflow_confidence: 0,
      session_velocity_7d: 0,
      stale_risk: 100,
      streak_days: 0
    };
  }
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const recentSessions = sessions.filter((s) => now - new Date(s.created_at).getTime() <= sevenDaysMs).length;
  const velocity = recentSessions / 7;
  const workflowCounts = Object.values(db.stats.workflow_counts);
  const topWf = workflowCounts.length > 0 ? Math.max(...workflowCounts) : 0;
  const confidence = topWf / total;
  const skillKeys = Object.keys(db.stats.skill_counts);
  const stale = skillKeys.filter((skill) => {
    const latest = sessions
      .filter((s) => s.skills_used.includes(skill))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!latest) return true;
    return now - new Date(latest.created_at).getTime() > 14 * 24 * 60 * 60 * 1000;
  }).length;
  const staleRisk = Math.round((stale / Math.max(1, skillKeys.length)) * 100);
  const behaviorScore = Math.min(100, Math.round(confidence * 60 + Math.min(1, velocity / 2) * 40));
  const daySet = new Set(sessions.map((s) => s.created_at.slice(0, 10)));

  return {
    behavior_score: behaviorScore,
    workflow_confidence: Number(confidence.toFixed(3)),
    session_velocity_7d: Number(velocity.toFixed(2)),
    stale_risk: staleRisk,
    streak_days: daySet.size
  };
}

export class JsonStorage {
  readonly dbPath: string;
  readonly root: string;

  constructor(baseDir?: string) {
    this.root = baseDir ?? path.join(process.cwd(), ".nms");
    fs.mkdirSync(this.root, { recursive: true });
    this.dbPath = path.join(this.root, "data.json");
    this.ensureV3Layout();
  }

  load(): Database {
    if (!fs.existsSync(this.dbPath)) {
      const rebuilt = this.rebuildDatabaseFromV3();
      if (rebuilt.sessions.length > 0) {
        this.save(rebuilt);
        this.writeDerivedSnapshots(rebuilt);
        return rebuilt;
      }
      return structuredClone(DEFAULT_DB);
    }
    const parsed = JSON.parse(fs.readFileSync(this.dbPath, "utf8")) as Partial<Database>;
    const migrated = this.migrate(parsed);
    if ((parsed.schema_version ?? 1) < 3) {
      this.backupLegacyData(parsed.schema_version ?? 1);
      this.save(migrated);
      this.rebuildV3FromDatabase(migrated);
    }
    return migrated;
  }

  save(db: Database): void {
    atomicWrite(this.dbPath, JSON.stringify(db, null, 2));
  }

  saveDerivedIngest(db: Database, profile: UserProfile, ingestMs: number, session?: SessionRecord): void {
    const stats = computeStatsFromSessions(db.sessions);
    db.stats.skill_counts = stats.skill_counts;
    db.stats.workflow_counts = stats.workflow_counts;
    db.stats.ingest_count += 1;
    db.stats.last_updated = new Date().toISOString();
    db.stats.perf_windows.ingest_ms = pushWindowMetric(
      db.stats.perf_windows.ingest_ms,
      ingestMs,
      db.stats.perf_windows.max_window
    );
    db.user_profile = profile;
    db.stats.quality_metrics = computeQualityMetrics(db);
    this.save(db);
    if (session) this.writeSessionArtifacts(session);
    this.writeDerivedSnapshots(db);
  }

  trackPerf(metric: "flow_ms" | "night_ms", valueMs: number): void {
    const db = this.load();
    db.stats.perf_windows[metric] = pushWindowMetric(
      db.stats.perf_windows[metric],
      valueMs,
      db.stats.perf_windows.max_window
    );
    this.save(db);
    this.writeDerivedSnapshots(db);
  }

  recentSessions(limit = 20): SessionRecord[] {
    const db = this.load();
    return [...db.sessions]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  mostCommonWorkflow(): string[] {
    const db = this.load();
    const [top] = Object.entries(db.stats.workflow_counts).sort((a, b) => b[1] - a[1]);
    return top ? top[0].split(" -> ") : [];
  }

  findDuplicateSession(db: Database, input: Pick<SessionRecord, "tool" | "compressed_text" | "conversation">): SessionRecord | undefined {
    const compressed = redactText(input.compressed_text);
    const conversation = redactText(input.conversation);
    return db.sessions.find(
      (s) =>
        s.tool === input.tool &&
        s.compressed_text === compressed &&
        s.conversation === conversation
    );
  }

  recordArtifact(record: Omit<ArtifactRecord, "artifact_id" | "created_at"> & { artifact_id?: string; created_at?: string }): ArtifactRecord {
    const full: ArtifactRecord = {
      artifact_id: record.artifact_id ?? `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: record.created_at ?? new Date().toISOString(),
      type: record.type,
      path: record.path,
      source_data_hash: record.source_data_hash,
      real_data_only: record.real_data_only,
      metadata: record.metadata
    };
    const registryPath = path.join(this.root, "artifacts", "artifacts.json");
    const existing = fs.existsSync(registryPath)
      ? (JSON.parse(fs.readFileSync(registryPath, "utf8")) as ArtifactRecord[])
      : [];
    atomicWrite(registryPath, JSON.stringify([...existing, full], null, 2));
    return full;
  }

  recordEvent(type: NmsEvent["type"], payloadRef: string, inputHash: string, sourceTool: SourceToolName = "codex"): NmsEvent {
    const event: NmsEvent = {
      event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      created_at: new Date().toISOString(),
      project_id: this.projectId(),
      source_tool: sourceTool,
      input_hash: inputHash,
      redaction_level: "safe",
      payload_ref: payloadRef
    };
    this.appendEvent(event);
    return event;
  }

  recordNightRun(report: unknown): string {
    const filePath = path.join(this.root, "artifacts", "night-runs", `night-${Date.now()}.json`);
    atomicWrite(filePath, JSON.stringify(report, null, 2));
    this.appendEvent({
      event_id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "NIGHT_RUN",
      created_at: new Date().toISOString(),
      project_id: this.projectId(),
      source_tool: "codex",
      input_hash: sha256(JSON.stringify(report)),
      redaction_level: "safe",
      payload_ref: relativeToRoot(this.root, filePath)
    });
    this.recordArtifact({
      type: "night-run",
      path: relativeToRoot(this.root, filePath),
      source_data_hash: sha256(JSON.stringify(report)),
      real_data_only: true,
      metadata: { kind: "night-run" }
    });
    return filePath;
  }

  buildAgentContext(taskSummary = ""): AgentContext {
    const db = this.load();
    const topWorkflowEntries = Object.entries(db.stats.workflow_counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const totalSessions = Math.max(1, db.sessions.length);
    const style = db.user_profile.style === "unknown" ? [] : db.user_profile.style.split("+").map((v) => v.trim());
    const warnings: string[] = [];
    if (db.sessions.length === 0) warnings.push("真实样本不足时不得编造用户偏好或 workflow。");
    if (db.stats.quality_metrics.stale_risk >= 60) warnings.push("部分技能陈旧，执行前优先参考最近任务。");

    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      project_id: this.projectId(),
      task_summary: taskSummary || "(not provided)",
      user_style: {
        communication: style.length > 0 ? style : ["样本不足，保持明确、结构化沟通"],
        workflow: db.user_profile.top_workflows.length > 0 ? db.user_profile.top_workflows : ["先澄清真实数据，再计划，再执行，再验证"],
        avoid: ["demo 数据", "空泛描述", "跳过测试", "越权写文件", "泄露密钥"]
      },
      relevant_workflows: topWorkflowEntries.map(([name, count]) => ({
        name,
        steps: name.split(" -> "),
        confidence: Number((count / totalSessions).toFixed(3)),
        evidence_refs: db.sessions
          .filter((s) => s.workflow.join(" -> ") === name)
          .slice(0, 3)
          .map((s) => s.id)
      })),
      recommended_agent_behavior: [
        "先说明将读取哪些真实数据和将写入哪些文件。",
        "涉及写文件前说明改动范围，执行后运行测试或给出未测原因。",
        "生成报告时标注数据来源、样本量和不足。"
      ],
      safety_policy: {
        default_apply: false,
        requires_explicit_apply: true,
        allowed_write_roots: DEFAULT_CONFIG.harness.allowed_roots,
        blocked_patterns: [".env", "secret", "token", "password", "private"]
      },
      data_quality: {
        sample_count: db.sessions.length,
        confidence: db.stats.quality_metrics.workflow_confidence,
        warnings
      }
    };
  }

  private ensureV3Layout(): void {
    for (const dir of [
      "events",
      "sessions",
      "derived",
      path.join("artifacts", "reports"),
      path.join("artifacts", "images"),
      path.join("artifacts", "prompts"),
      path.join("artifacts", "night-runs"),
      "policies",
      "domains",
      "backups"
    ]) {
      fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    }
    this.writeIfMissing("config.json", {
      schema_version: 3,
      project_id: this.projectId(),
      created_at: new Date().toISOString()
    });
    this.writeIfMissing(path.join("policies", "safety.json"), {
      default_apply: false,
      requires_explicit_apply: true,
      allowed_write_roots: DEFAULT_CONFIG.harness.allowed_roots,
      core_explicit_whitelist: DEFAULT_CONFIG.harness.core_explicit_whitelist
    });
    this.writeIfMissing(path.join("policies", "redaction.json"), {
      enabled: true,
      patterns: ["Bearer <token>", "sk-<secret>", "api_key=<secret>", "token=<secret>"]
    });
    this.writeIfMissing(path.join("artifacts", "artifacts.json"), []);
    for (const domain of DEFAULT_DOMAINS) {
      const name = String((domain as { domain: string }).domain);
      this.writeIfMissing(path.join("domains", `${name}.json`), domain);
    }
  }

  private writeIfMissing(relPath: string, data: unknown): void {
    const filePath = path.join(this.root, relPath);
    if (!fs.existsSync(filePath)) atomicWrite(filePath, JSON.stringify(data, null, 2));
  }

  private backupLegacyData(schemaVersion: number): void {
    if (!fs.existsSync(this.dbPath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.root, "backups", `data-v${schemaVersion}-${stamp}.json`);
    fs.copyFileSync(this.dbPath, backupPath);
  }

  private projectId(): string {
    return path.basename(path.resolve(this.root, "..")) || "nms-project";
  }

  private eventPath(createdAt: string): string {
    return path.join(this.root, "events", `${createdAt.slice(0, 7)}.jsonl`);
  }

  private sessionPath(session: SessionRecord): string {
    return path.join(
      this.root,
      "sessions",
      session.created_at.slice(0, 4),
      session.created_at.slice(5, 7),
      `${session.id}.json`
    );
  }

  private appendEvent(event: NmsEvent): void {
    const filePath = this.eventPath(event.created_at);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private toSessionV3(session: SessionRecord): SessionV3 {
    const source = `${session.compressed_text}\n${session.conversation}`;
    return {
      id: session.id,
      created_at: session.created_at,
      project_id: this.projectId(),
      domain: detectDomain(session),
      source_tool: session.tool as SourceToolName,
      compressed_text_ref: "inline:redacted",
      conversation_ref: "inline:redacted",
      skills: session.skills_used.map((name) => ({
        name,
        category: skillCategory(name),
        confidence: 1,
        evidence: compactEvidence(source, name)
      })),
      workflow: {
        steps: session.workflow,
        edges: session.edges,
        confidence: workflowConfidence(session)
      },
      user_style_observations: session.user_style
        ? [
            {
              claim: session.user_style,
              confidence: session.user_style === "unknown" ? 0 : 0.6,
              evidence: [redactText(session.conversation).slice(0, 120)]
            }
          ]
        : []
    };
  }

  private writeSessionArtifacts(session: SessionRecord): void {
    const sessionV3 = this.toSessionV3(session);
    const sessionFile = this.sessionPath(session);
    atomicWrite(sessionFile, JSON.stringify(sessionV3, null, 2));
    this.appendEvent({
      event_id: `evt_${session.id}`,
      type: "CONTEXT_COMPRESSED",
      created_at: session.created_at,
      project_id: this.projectId(),
      source_tool: session.tool as SourceToolName,
      input_hash: sha256(`${session.tool}\n${session.compressed_text}\n${session.conversation}`),
      redaction_level: "safe",
      payload_ref: relativeToRoot(this.root, sessionFile)
    });
  }

  private writeDerivedSnapshots(db: Database): void {
    atomicWrite(path.join(this.root, "derived", "stats.json"), JSON.stringify(db.stats, null, 2));
    atomicWrite(path.join(this.root, "derived", "profile.json"), JSON.stringify(db.user_profile, null, 2));
    atomicWrite(path.join(this.root, "derived", "quality.json"), JSON.stringify(db.stats.quality_metrics, null, 2));
    const workflows = Object.entries(db.stats.workflow_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, steps: name.split(" -> "), count }));
    atomicWrite(path.join(this.root, "derived", "workflows.json"), JSON.stringify(workflows, null, 2));
    atomicWrite(path.join(this.root, "derived", "agent-context.json"), JSON.stringify(this.buildAgentContext(), null, 2));
  }

  private rebuildV3FromDatabase(db: Database): void {
    for (const session of db.sessions) this.writeSessionArtifacts(session);
    this.writeDerivedSnapshots(db);
  }

  private v3SessionFiles(): string[] {
    const root = path.join(this.root, "sessions");
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
      }
    };
    visit(root);
    return out;
  }

  private rebuildDatabaseFromV3(): Database {
    const sessions = this.v3SessionFiles()
      .map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as SessionV3)
      .map<SessionRecord>((session) => ({
        id: session.id,
        created_at: session.created_at,
        compressed_text: "",
        conversation: "",
        tool: session.source_tool === "unknown" ? "codex" : session.source_tool,
        skills_used: session.skills.map((skill) => skill.name),
        workflow: session.workflow.steps,
        edges: session.workflow.edges,
        user_style: session.user_style_observations[0]?.claim ?? "unknown"
      }))
      .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    const stats = computeStatsFromSessions(sessions);
    const profile: UserProfile = {
      style: sessions.at(-1)?.user_style ?? "unknown",
      top_skills: Object.entries(stats.skill_counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name),
      top_workflows: Object.entries(stats.workflow_counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name),
      updated_at: new Date().toISOString()
    };
    const db: Database = structuredClone(DEFAULT_DB);
    db.sessions = sessions;
    db.stats.skill_counts = stats.skill_counts;
    db.stats.workflow_counts = stats.workflow_counts;
    db.stats.ingest_count = sessions.length;
    db.stats.last_updated = new Date().toISOString();
    db.user_profile = profile;
    db.stats.quality_metrics = computeQualityMetrics(db);
    return db;
  }

  private migrate(input: Partial<Database>): Database {
    const merged: Database = {
      schema_version: 3,
      sessions: (input.sessions ?? []).map((session) => ({
        ...session,
        compressed_text: redactText(session.compressed_text ?? ""),
        conversation: redactText(session.conversation ?? "")
      })),
      stats: {
        ...DEFAULT_DB.stats,
        ...(input.stats ?? {}),
        perf_windows: {
          ...DEFAULT_DB.stats.perf_windows,
          ...(input.stats?.perf_windows ?? {})
        },
        quality_metrics: {
          ...DEFAULT_DB.stats.quality_metrics,
          ...(input.stats?.quality_metrics ?? {})
        }
      },
      user_profile: {
        ...DEFAULT_DB.user_profile,
        ...(input.user_profile ?? {})
      }
    };
    if ((input.schema_version ?? 1) < 3) {
      const stats = computeStatsFromSessions(merged.sessions);
      merged.stats.skill_counts = stats.skill_counts;
      merged.stats.workflow_counts = stats.workflow_counts;
      merged.stats.quality_metrics = computeQualityMetrics(merged);
    }
    return merged;
  }
}
