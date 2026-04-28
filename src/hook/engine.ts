import { DEFAULT_CONFIG } from "../config.js";
import { JsonStorage } from "../storage.js";
import type { HookInput, HookOutput } from "../types.js";
import { cleanSessions } from "./cleaner.js";
import { extractSkills } from "./extractor.js";
import { buildUserProfile } from "./profile.js";
import { buildEdges, buildWorkflow } from "./workflow.js";

export function processCompressedEvent(input: HookInput, storage = new JsonStorage()): HookOutput {
  const mergedText = `${input.compressed_text}\n${input.conversation}`;
  const skills = extractSkills(mergedText);
  const workflow = buildWorkflow(mergedText, skills);
  const output: HookOutput = {
    skills_used: skills,
    workflow,
    edges: buildEdges(workflow),
    user_style: buildUserProfile(storage.recentSessions(1)).style
  };

  const session = storage.appendSession({ ...input, ...output });
  const db = storage.load();
  const cleaned = cleanSessions(db.sessions, DEFAULT_CONFIG);
  db.sessions = cleaned;
  storage.save(db);
  const profile = buildUserProfile(cleaned);
  storage.updateProfile(profile);

  return {
    ...output,
    user_style: profile.style || session.user_style
  };
}
