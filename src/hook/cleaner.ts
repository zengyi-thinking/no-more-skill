import type { NmsConfig, SessionRecord } from "../types.js";

function normalizeSkill(skill: string): string {
  return skill.replace(/\s+/g, "").toLowerCase();
}

function topByCount(counts: Record<string, number>, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

export function cleanSessions(sessions: SessionRecord[], config: NmsConfig): SessionRecord[] {
  const now = Date.now();
  const recentMs = 7 * 24 * 60 * 60 * 1000;
  const decayMs = config.cleaner.decay_days * 24 * 60 * 60 * 1000;
  const active = sessions.filter((s) => now - new Date(s.created_at).getTime() <= decayMs);

  const recentCounts: Record<string, number> = {};
  const allCounts: Record<string, number> = {};
  const workflowLinkedSkills = new Set<string>();

  for (const s of active) {
    const isRecent = now - new Date(s.created_at).getTime() <= recentMs;
    for (const skill of s.skills_used) {
      allCounts[skill] = (allCounts[skill] ?? 0) + 1;
      if (isRecent) recentCounts[skill] = (recentCounts[skill] ?? 0) + 1;
    }
    for (const w of s.workflow) workflowLinkedSkills.add(w);
  }

  const keepRecentHigh = topByCount(recentCounts, config.cleaner.max_skills);
  const keepHistoryTop = topByCount(allCounts, config.cleaner.max_skills);
  const keepSet = new Set<string>([...keepRecentHigh, ...keepHistoryTop]);

  const normalizedPick = new Map<string, string>();
  for (const candidate of keepSet) {
    const key = normalizeSkill(candidate);
    const existing = normalizedPick.get(key);
    if (!existing || (allCounts[candidate] ?? 0) > (allCounts[existing] ?? 0) || candidate.length > existing.length) {
      normalizedPick.set(key, candidate);
    }
  }
  const keptSkills = new Set<string>([...normalizedPick.values()].slice(0, config.cleaner.max_skills));

  return active.map((s) => {
    const filteredSkills = s.skills_used.filter(
      (skill) => keptSkills.has(skill) || workflowLinkedSkills.has(skill)
    );
    const workflow = s.workflow.slice(0, config.cleaner.max_workflows);
    return { ...s, skills_used: filteredSkills, workflow };
  });
}
