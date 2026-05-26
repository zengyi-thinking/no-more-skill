import type { DomainPack } from "../types.js";
import { allDomainSkills } from "./domainPacks.js";
import { FLAT_SKILLS } from "./skillDictionary.js";

export function extractSkills(text: string, packs?: DomainPack[]): string[] {
  const dictionary = packs ? allDomainSkills(packs) : FLAT_SKILLS;
  const hits = dictionary
    .filter((skill) => text.includes(skill))
    .sort((a, b) => b.length - a.length);
  const selected: string[] = [];
  for (const hit of hits) {
    if (selected.some((existing) => existing.includes(hit))) continue;
    selected.push(hit);
  }
  return selected.sort((a, b) => text.indexOf(a) - text.indexOf(b));
}
