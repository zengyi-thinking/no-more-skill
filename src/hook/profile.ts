import type { SessionRecord, UserProfile } from "../types.js";

function topNCount(map: Record<string, number>, n = 5): string[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

export function inferStyle(conversation: string): string {
  const hasSteps = /步骤|step|1\.|2\./i.test(conversation);
  const hasStructure = /总结|结构|模块|架构|流程/i.test(conversation);
  if (hasSteps && hasStructure) return "结构化 + 分步骤";
  if (hasSteps) return "分步骤";
  if (hasStructure) return "结构化";
  return "探索式";
}

export function buildUserProfile(sessions: SessionRecord[]): UserProfile {
  const skillCounts: Record<string, number> = {};
  const workflowCounts: Record<string, number> = {};
  for (const s of sessions) {
    for (const skill of s.skills_used) skillCounts[skill] = (skillCounts[skill] ?? 0) + 1;
    const key = s.workflow.join(" -> ");
    if (key) workflowCounts[key] = (workflowCounts[key] ?? 0) + 1;
  }
  const latest = sessions.at(-1);
  return {
    style: latest ? inferStyle(latest.conversation) : "unknown",
    top_skills: topNCount(skillCounts, 5),
    top_workflows: topNCount(workflowCounts, 5),
    updated_at: new Date().toISOString()
  };
}
