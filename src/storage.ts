import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AgentContext,
  ArtifactRecord,
  AuditRecord,
  BirthdayCapsule,
  BirthdayWishContract,
  Database,
  NmsEvent,
  SessionRecord,
  SessionV3,
  SourceToolName,
  DomainPack,
  UserProfile
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import {
  categoryForSkill,
  DEFAULT_DOMAIN_PACKS,
  detectDomainFromText,
  detectSessionDomain
} from "./hook/domainPacks.js";

const PERF_WINDOW_SIZE = 100;

const DEFAULT_DB: Database = {
  schema_version: 3,
  sessions: [],
  stats: {
    skill_counts: {},
    workflow_counts: {},
    domain_counts: {},
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

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
      return;
    }
    throw error;
  }
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

function relativeToRoot(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function pushWindowMetric(target: number[], value: number, max: number): number[] {
  const next = [...target, value];
  return next.length <= max ? next : next.slice(next.length - max);
}

function computeStatsFromSessions(sessions: SessionRecord[]): Pick<Database["stats"], "skill_counts" | "workflow_counts" | "domain_counts"> {
  const skill_counts: Record<string, number> = {};
  const workflow_counts: Record<string, number> = {};
  const domain_counts: Record<string, number> = {};
  for (const s of sessions) {
    for (const skill of s.skills_used) skill_counts[skill] = (skill_counts[skill] ?? 0) + 1;
    const wfKey = s.workflow.join(" -> ");
    if (wfKey) workflow_counts[wfKey] = (workflow_counts[wfKey] ?? 0) + 1;
    const domain = s.domain ?? "coding";
    domain_counts[domain] = (domain_counts[domain] ?? 0) + 1;
  }
  return { skill_counts, workflow_counts, domain_counts };
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
    db.stats.domain_counts = stats.domain_counts;
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

  loadDomainPacks(): DomainPack[] {
    const domainDir = path.join(this.root, "domains");
    if (!fs.existsSync(domainDir)) return DEFAULT_DOMAIN_PACKS;
    const packs = fs
      .readdirSync(domainDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(domainDir, entry))
      .map((file) => {
        try {
          return JSON.parse(fs.readFileSync(file, "utf8")) as DomainPack;
        } catch {
          return undefined;
        }
      })
      .filter((pack): pack is DomainPack =>
        Boolean(pack?.domain && pack.skills && pack.workflow_templates && pack.style_signals)
      );
    return packs.length > 0 ? packs : DEFAULT_DOMAIN_PACKS;
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

  recordAudit(record: Omit<AuditRecord, "audit_id" | "created_at"> & { audit_id?: string; created_at?: string }): string {
    const full: AuditRecord = {
      audit_id: record.audit_id ?? `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: record.created_at ?? new Date().toISOString(),
      command: record.command,
      triggered_by: record.triggered_by,
      policy_profile: record.policy_profile,
      input_summary: record.input_summary,
      file_scope: record.file_scope,
      gate_result: record.gate_result,
      artifact_paths: record.artifact_paths,
      notes: record.notes
    };
    const auditPath = path.join(this.root, "audit", `${full.created_at.slice(0, 7)}.jsonl`);
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(full)}\n`, "utf8");
    this.recordArtifact({
      type: "audit",
      path: relativeToRoot(this.root, auditPath),
      source_data_hash: sha256(JSON.stringify(full)),
      real_data_only: true,
      metadata: {
        command: full.command,
        gate_result: full.gate_result,
        policy_profile: full.policy_profile
      }
    });
    return relativeToRoot(this.root, auditPath);
  }

  recordErrorArtifact(payload: {
    kind: string;
    source: string;
    reason: string;
    recovery_hint: string;
    next_safe_command: string;
    input_summary?: string;
  }): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(this.root, "artifacts", "errors", `${payload.kind}-${stamp}.json`);
    atomicWrite(
      filePath,
      JSON.stringify(
        {
          created_at: new Date().toISOString(),
          ...payload
        },
        null,
        2
      )
    );
    this.recordArtifact({
      type: "error",
      path: relativeToRoot(this.root, filePath),
      source_data_hash: sha256(JSON.stringify(payload)),
      real_data_only: true,
      metadata: { kind: payload.kind, source: payload.source }
    });
    return filePath;
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

  private readLatestBirthdayMemory(): AgentContext["birthday_memory"] | undefined {
    const capsulePath = path.join(this.root, "derived", "birthday", "latest.json");
    if (!fs.existsSync(capsulePath)) return undefined;
    try {
      const capsule = JSON.parse(fs.readFileSync(capsulePath, "utf8")) as BirthdayCapsule;
      return {
        latest_capsule_ref: relativeToRoot(this.root, capsulePath),
        generated_at: capsule.generated_at,
        north_star: capsule.north_star,
        retained_commitments: capsule.retained_commitments,
        personality_tags: capsule.personality_tags ?? [],
        evolution_summary: capsule.evolution_summary ?? {
          headline: "生日资产仍在学习中。",
          narrative: ["样本不足时，NMS 只保留北极星和边界，不做夸张归纳。"]
        },
        behavior_delta: capsule.behavior_delta ?? {
          sample_count_delta: 0,
          behavior_score_delta: 0,
          workflow_confidence_delta: 0,
          stale_risk_delta: 0,
          domain_shift: {
            current: null,
            previous: null,
            changed: false,
            signal: "样本不足，暂不判断领域迁移。"
          },
          skill_changes: []
        },
        evolution_lanes: capsule.evolution_lanes ?? {
          inherit_keep: capsule.retained_commitments ?? [],
          retire_stop: [],
          new_growth: capsule.next_year_targets ?? []
        },
        next_year_targets: capsule.next_year_targets,
        risks_to_watch: capsule.risks_to_watch
      };
    } catch {
      return undefined;
    }
  }

  private readLatestBirthdayWish(): AgentContext["birthday_wish"] | undefined {
    const wishPath = path.join(this.root, "derived", "birthday-wish", "latest.json");
    if (!fs.existsSync(wishPath)) return undefined;
    try {
      const wish = JSON.parse(fs.readFileSync(wishPath, "utf8")) as BirthdayWishContract;
      return {
        latest_wish_ref: relativeToRoot(this.root, wishPath),
        generated_at: wish.generated_at,
        source: wish.source,
        status: wish.status,
        wish_text: wish.wish_text,
        wish_type: wish.wish_type,
        horizon: wish.horizon,
        north_star_alignment: wish.north_star_alignment,
        groundedness: {
          score: wish.groundedness.score,
          level: wish.groundedness.level,
          why: wish.groundedness.why
        },
        execution_contract: {
          keep: wish.execution_contract.keep,
          stop: wish.execution_contract.stop,
          start: wish.execution_contract.start,
          next_agent_bias: wish.execution_contract.next_agent_bias
        },
        progress: {
          trend: wish.progress.trend,
          summary: wish.progress.summary
        }
      };
    } catch {
      return undefined;
    }
  }

  buildAgentContext(taskSummary = ""): AgentContext {
    const db = this.load();
    const topWorkflowEntries = Object.entries(db.stats.workflow_counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topDomainEntries = Object.entries(db.stats.domain_counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const totalSessions = Math.max(1, db.sessions.length);
    const style = db.user_profile.style === "unknown" ? [] : db.user_profile.style.split("+").map((v) => v.trim());
    const warnings: string[] = [];
    if (db.sessions.length === 0) warnings.push("真实样本不足时不得编造用户偏好或 workflow。");
    if (db.stats.quality_metrics.stale_risk >= 60) warnings.push("部分技能陈旧，执行前优先参考最近任务。");

    const context: AgentContext = {
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
      relevant_domains: topDomainEntries.map(([name, count]) => ({
        name,
        count,
        confidence: Number((count / totalSessions).toFixed(3))
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
        policy_profile: "strict",
        blocked_patterns: [".env", "secret", "token", "password", "private"]
      },
      data_quality: {
        sample_count: db.sessions.length,
        confidence: db.stats.quality_metrics.workflow_confidence,
        warnings
      }
    };
    const birthdayMemory = this.readLatestBirthdayMemory();
    if (birthdayMemory) context.birthday_memory = birthdayMemory;
    const birthdayWish = this.readLatestBirthdayWish();
    if (birthdayWish) context.birthday_wish = birthdayWish;
    return context;
  }

  private ensureV3Layout(): void {
    for (const dir of [
      "events",
      "sessions",
      "derived",
      path.join("artifacts", "reports"),
      path.join("artifacts", "images"),
      path.join("artifacts", "prompts"),
      path.join("artifacts", "birthday-wish"),
      path.join("artifacts", "night-runs"),
      path.join("artifacts", "auto"),
      path.join("artifacts", "errors"),
      "audit",
      "inbox",
      path.join("inbox", "archive"),
      path.join("inbox", "failed"),
      "policies",
      "domains",
      path.join("derived", "birthday-wish"),
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
      core_explicit_whitelist: DEFAULT_CONFIG.harness.core_explicit_whitelist,
      policy_profiles: DEFAULT_CONFIG.harness.policy_profiles
    });
    this.writeIfMissing(path.join("policies", "redaction.json"), {
      enabled: true,
      patterns: ["Bearer <token>", "sk-<secret>", "api_key=<secret>", "token=<secret>"]
    });
    this.writeIfMissing(path.join("artifacts", "artifacts.json"), []);
    for (const domain of DEFAULT_DOMAIN_PACKS) {
      const name = domain.domain;
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
    const packs = this.loadDomainPacks();
    const domainGuess = session.domain
      ? { domain: session.domain, confidence: session.domain_confidence ?? 1 }
      : detectDomainFromText(source, packs);
    return {
      id: session.id,
      created_at: session.created_at,
      project_id: this.projectId(),
      domain: domainGuess.domain,
      domain_confidence: domainGuess.confidence,
      source_tool: session.tool as SourceToolName,
      compressed_text_ref: "inline:redacted",
      conversation_ref: "inline:redacted",
      skills: session.skills_used.map((name) => ({
        name,
        category: categoryForSkill(name, packs),
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
    const domains = Object.entries(db.stats.domain_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    atomicWrite(path.join(this.root, "derived", "domains.json"), JSON.stringify(domains, null, 2));
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
        user_style: session.user_style_observations[0]?.claim ?? "unknown",
        domain: session.domain,
        domain_confidence: session.domain_confidence
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
    db.stats.domain_counts = stats.domain_counts;
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
        conversation: redactText(session.conversation ?? ""),
        domain: session.domain ?? detectSessionDomain(session as SessionRecord, DEFAULT_DOMAIN_PACKS)
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
    if ((input.schema_version ?? 1) < 3 || !input.stats?.domain_counts) {
      const stats = computeStatsFromSessions(merged.sessions);
      merged.stats.skill_counts = stats.skill_counts;
      merged.stats.workflow_counts = stats.workflow_counts;
      merged.stats.domain_counts = stats.domain_counts;
      merged.stats.quality_metrics = computeQualityMetrics(merged);
    }
    return merged;
  }
}
