import fs from "node:fs";
import { z } from "zod";
import { runNightHarness } from "./harness/engine.js";
import { processCompressedEvent } from "./hook/engine.js";
import { JsonStorage } from "./storage.js";
import type { HookInput } from "./types.js";

const InputSchema = z.object({
  compressed_text: z.string(),
  conversation: z.string(),
  tool: z.enum(["claude", "codex"])
});

function readPayload(inputFile?: string): string {
  if (inputFile) return fs.readFileSync(inputFile, "utf8");
  return fs.readFileSync(0, "utf8");
}

export function ingestCommand(inputFile?: string): string {
  const raw = readPayload(inputFile);
  const parsed = InputSchema.parse(JSON.parse(raw)) as HookInput;
  const out = processCompressedEvent(parsed);
  return JSON.stringify(out, null, 2);
}

export function flowCommand(): string {
  const storage = new JsonStorage();
  const db = storage.load();
  const recent = storage.recentSessions(3).map((s) => s.workflow);
  const skillEntries = Object.entries(db.stats.skill_counts).sort((a, b) => b[1] - a[1]);
  const topSkills = skillEntries.slice(0, 5).map(([k, v]) => `${k}(${v})`);
  const idleSkills = skillEntries.slice(5).map(([k]) => k);
  const suggestion = db.user_profile.top_workflows[0]
    ? `建议复用 workflow: ${db.user_profile.top_workflows[0]}`
    : "建议先通过 nms ingest 积累行为数据";

  return [
    "== 最近 workflow ==",
    JSON.stringify(recent, null, 2),
    "== 高频技能 ==",
    topSkills.join(", ") || "(none)",
    "== 闲置技能 ==",
    idleSkills.join(", ") || "(none)",
    "== 下一步建议 ==",
    suggestion
  ].join("\n");
}

export function replayCommand(): string {
  const storage = new JsonStorage();
  const wf = storage.mostCommonWorkflow();
  if (wf.length === 0) return "暂无可复现 workflow，请先 ingest。";
  return `Replaying workflow:\n${wf.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
}

export function nightCommand(options: { dryRun?: boolean; apply?: boolean; timeBudget?: number }): string {
  const apply = Boolean(options.apply);
  const dryRun = apply ? false : options.dryRun ?? true;
  const report = runNightHarness({
    dryRun,
    apply,
    timeBudgetMinutes: options.timeBudget ?? 5
  });
  return JSON.stringify(report, null, 2);
}
