import { FLAT_SKILLS } from "./skillDictionary.js";

export function extractSkills(text: string): string[] {
  const hits = FLAT_SKILLS.filter((skill) => text.includes(skill));
  return [...new Set(hits)];
}
