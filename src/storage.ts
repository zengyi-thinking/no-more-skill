import fs from "node:fs";
import path from "node:path";
import type { Database, SessionRecord, UserProfile } from "./types.js";

const PERF_WINDOW_SIZE = 100;

const DEFAULT_DB: Database = {
  schema_version: 2,
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

  constructor(baseDir?: string) {
    const root = baseDir ?? path.join(process.cwd(), ".nms");
    fs.mkdirSync(root, { recursive: true });
    this.dbPath = path.join(root, "data.json");
  }

  load(): Database {
    if (!fs.existsSync(this.dbPath)) return structuredClone(DEFAULT_DB);
    const parsed = JSON.parse(fs.readFileSync(this.dbPath, "utf8")) as Partial<Database>;
    const migrated = this.migrate(parsed);
    if ((parsed.schema_version ?? 1) < 2) this.save(migrated);
    return migrated;
  }

  save(db: Database): void {
    fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2), "utf8");
  }

  saveDerivedIngest(db: Database, profile: UserProfile, ingestMs: number): void {
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
  }

  trackPerf(metric: "flow_ms" | "night_ms", valueMs: number): void {
    const db = this.load();
    db.stats.perf_windows[metric] = pushWindowMetric(
      db.stats.perf_windows[metric],
      valueMs,
      db.stats.perf_windows.max_window
    );
    this.save(db);
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
    return db.sessions.find(
      (s) =>
        s.tool === input.tool &&
        s.compressed_text === input.compressed_text &&
        s.conversation === input.conversation
    );
  }

  private migrate(input: Partial<Database>): Database {
    const merged: Database = {
      schema_version: 2,
      sessions: input.sessions ?? [],
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
    if ((input.schema_version ?? 1) < 2) {
      const stats = computeStatsFromSessions(merged.sessions);
      merged.stats.skill_counts = stats.skill_counts;
      merged.stats.workflow_counts = stats.workflow_counts;
      merged.stats.quality_metrics = computeQualityMetrics(merged);
    }
    return merged;
  }
}
