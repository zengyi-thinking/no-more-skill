import { DEFAULT_CONFIG } from "../config.js";
import { JsonStorage, redactText } from "../storage.js";
import type { HookInput, HookOutput } from "../types.js";
import { cleanSessions } from "./cleaner.js";
import { extractSkills } from "./extractor.js";
import { buildUserProfile } from "./profile.js";
import { detectDomainFromText, domainPackFor } from "./domainPacks.js";
import { buildEdges, buildWorkflow } from "./workflow.js";

export function processCompressedEvent(input: HookInput, storage = new JsonStorage()): HookOutput {
  const started = performance.now();
  const db = storage.load();
  const duplicate = storage.findDuplicateSession(db, input);
  if (duplicate) {
    return {
      skills_used: duplicate.skills_used,
      workflow: duplicate.workflow,
      edges: duplicate.edges,
      user_style: duplicate.user_style
    };
  }

  const mergedText = `${input.compressed_text}\n${input.conversation}`;
  const domainPacks = storage.loadDomainPacks();
  const domainGuess = detectDomainFromText(mergedText, domainPacks);
  const activeDomainPack = domainPackFor(domainGuess.domain, domainPacks);
  const skills = extractSkills(mergedText, domainPacks);
  const workflow = buildWorkflow(mergedText, skills, activeDomainPack.workflow_templates);
  const baseOutput: HookOutput = {
    skills_used: skills,
    workflow,
    edges: buildEdges(workflow),
    user_style: db.user_profile.style
  };

  const session = {
    ...input,
    compressed_text: redactText(input.compressed_text),
    conversation: redactText(input.conversation),
    ...baseOutput,
    domain: domainGuess.domain,
    domain_confidence: domainGuess.confidence,
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString()
  };
  const cleaned = cleanSessions([...db.sessions, session], DEFAULT_CONFIG);
  db.sessions = cleaned;
  const profile = buildUserProfile(cleaned);
  const ingestMs = Number((performance.now() - started).toFixed(2));
  storage.saveDerivedIngest(db, profile, ingestMs, session);

  return {
    ...baseOutput,
    user_style: profile.style || session.user_style
  };
}
