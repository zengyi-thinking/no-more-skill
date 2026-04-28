import fs from "node:fs";
import path from "node:path";
import type { Database, HookOutput, SessionRecord } from "./types.js";

const DEFAULT_DB: Database = {
  schema_version: 1,
  sessions: [],
  stats: {
    skill_counts: {},
    workflow_counts: {},
    last_updated: new Date(0).toISOString()
  },
  user_profile: {
    style: "unknown",
    top_skills: [],
    top_workflows: [],
    updated_at: new Date(0).toISOString()
  }
};

export class JsonStorage {
  readonly dbPath: string;

  constructor(baseDir?: string) {
    const root = baseDir ?? path.join(process.cwd(), ".nms");
    fs.mkdirSync(root, { recursive: true });
    this.dbPath = path.join(root, "data.json");
  }

  load(): Database {
    if (!fs.existsSync(this.dbPath)) return structuredClone(DEFAULT_DB);
    const raw = fs.readFileSync(this.dbPath, "utf8");
    return JSON.parse(raw) as Database;
  }

  save(db: Database): void {
    fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2), "utf8");
  }

  appendSession(input: Omit<SessionRecord, "id" | "created_at">): SessionRecord {
    const db = this.load();
    const existing = db.sessions.find(
      (s) =>
        s.tool === input.tool &&
        s.compressed_text === input.compressed_text &&
        s.conversation === input.conversation
    );
    if (existing) return existing;

    const session: SessionRecord = {
      ...input,
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString()
    };
    db.sessions.push(session);
    this.recomputeStats(db);
    this.save(db);
    return session;
  }

  updateProfile(profile: Database["user_profile"]): void {
    const db = this.load();
    db.user_profile = profile;
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
    if (!top) return [];
    return top[0].split(" -> ");
  }

  private recomputeStats(db: Database): void {
    const skill_counts: Record<string, number> = {};
    const workflow_counts: Record<string, number> = {};
    for (const s of db.sessions) {
      for (const skill of s.skills_used) skill_counts[skill] = (skill_counts[skill] ?? 0) + 1;
      const wfKey = s.workflow.join(" -> ");
      if (wfKey) workflow_counts[wfKey] = (workflow_counts[wfKey] ?? 0) + 1;
    }
    db.stats = {
      skill_counts,
      workflow_counts,
      last_updated: new Date().toISOString()
    };
  }
}

export function updateSessionWithCleaner(
  session: SessionRecord,
  cleaned: HookOutput
): SessionRecord {
  return {
    ...session,
    skills_used: cleaned.skills_used,
    workflow: cleaned.workflow,
    edges: cleaned.edges,
    user_style: cleaned.user_style
  };
}
