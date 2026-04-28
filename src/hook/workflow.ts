export function buildWorkflow(conversation: string, skills: string[]): string[] {
  const ordered = skills
    .map((skill) => ({ skill, idx: conversation.indexOf(skill) }))
    .filter((entry) => entry.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.skill);
  return [...new Set(ordered)].slice(0, 5);
}

export function buildEdges(workflow: string[]): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < workflow.length - 1; i += 1) {
    edges.push({ from: workflow[i], to: workflow[i + 1] });
  }
  return edges;
}
