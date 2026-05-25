export const SKILL_DICTIONARY: Record<string, string[]> = {
  "分析类": ["PRD分析", "代码分析"],
  "生成类": ["UI生成", "代码生成"],
  "优化类": ["Prompt优化", "性能优化"],
  "调试类": ["Debug"],
  "设计类": ["架构设计"]
};

export const FLAT_SKILLS = Object.values(SKILL_DICTIONARY).flat();

export function skillCategory(skill: string): string {
  for (const [category, skills] of Object.entries(SKILL_DICTIONARY)) {
    if (skills.includes(skill)) return category;
  }
  return "unknown";
}
