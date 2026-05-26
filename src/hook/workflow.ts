export function buildWorkflow(conversation: string, skills: string[], templates: string[][] = []): string[] {
  const ordered = skills
    .map((skill) => ({ skill, idx: conversation.indexOf(skill) }))
    .filter((entry) => entry.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.skill);
  const explicit = [...new Set(ordered)];
  if (explicit.length > 0) return explicit.slice(0, 5);

  const skillSet = new Set(skills);
  const templateOrder = templates
    .flatMap((template) => template.filter((step) => skillSet.has(step)))
    .filter((step, index, arr) => arr.indexOf(step) === index);
  return templateOrder.slice(0, 5);
}

export function buildEdges(workflow: string[]): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < workflow.length - 1; i += 1) {
    edges.push({ from: workflow[i], to: workflow[i + 1] });
  }
  return edges;
}
