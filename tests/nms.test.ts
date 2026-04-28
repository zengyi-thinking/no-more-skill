import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { flowCommand, ingestCommand, nightCommand, replayCommand } from "../src/commands.js";
import { cleanSessions } from "../src/hook/cleaner.js";
import type { SessionRecord } from "../src/types.js";

function withTempCwd(fn: () => void) {
  const old = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(old);
  }
}

describe.sequential("NMS v1.1 MVP", () => {
  test("ingest writes session and is idempotent", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "今天做 PRD分析 和 代码生成",
        conversation: "先 PRD分析 再 代码生成",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");

      ingestCommand(inputFile);
      ingestCommand(inputFile);

      const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".nms", "data.json"), "utf8"));
      expect(db.sessions.length).toBe(1);
      expect(db.sessions[0].skills_used).toContain("PRD分析");
      expect(db.sessions[0].skills_used).toContain("代码生成");
    });
  });

  test("flow and replay are stable on empty/non-empty data", () => {
    withTempCwd(() => {
      const emptyFlow = flowCommand();
      expect(emptyFlow).toContain("最近 workflow");
      expect(replayCommand()).toContain("暂无可复现 workflow");

      const payload = {
        compressed_text: "PRD分析 UI生成 代码生成",
        conversation: "PRD分析 UI生成 代码生成",
        tool: "claude"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");
      ingestCommand(inputFile);

      const flow = flowCommand();
      expect(flow).toContain("高频技能");
      expect(replayCommand()).toContain("Replaying workflow");
    });
  });

  test("cleaner preserves recency + topN + limits", () => {
    const now = Date.now();
    const sessions: SessionRecord[] = [
      {
        id: "1",
        created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        compressed_text: "",
        conversation: "",
        tool: "codex",
        skills_used: ["PRD分析", "代码分析", "UI生成"],
        workflow: ["PRD分析", "UI生成"],
        edges: [],
        user_style: "结构化"
      },
      {
        id: "2",
        created_at: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
        compressed_text: "",
        conversation: "",
        tool: "claude",
        skills_used: ["Prompt优化"],
        workflow: ["Prompt优化"],
        edges: [],
        user_style: "结构化"
      }
    ];

    const cleaned = cleanSessions(sessions, DEFAULT_CONFIG);
    expect(cleaned.length).toBe(1);
    expect(cleaned[0].skills_used.length).toBeLessThanOrEqual(DEFAULT_CONFIG.cleaner.max_skills);
    expect(cleaned[0].workflow.length).toBeLessThanOrEqual(DEFAULT_CONFIG.cleaner.max_workflows);
  });

  test("night dry-run runs full state machine", () => {
    withTempCwd(() => {
      const out = JSON.parse(nightCommand({ dryRun: true, timeBudget: 1 }));
      expect(out.dry_run).toBe(true);
      expect(out.logs.join(" ")).toContain("State=PLAN");
      expect(out.logs.join(" ")).toContain("State=GATE");
    });
  });

  test("night apply is blocked by default and safety checks", () => {
    withTempCwd(() => {
      const dry = JSON.parse(nightCommand({}));
      expect(dry.dry_run).toBe(true);

      const applyInNoGit = JSON.parse(nightCommand({ apply: true }));
      expect(applyInNoGit.final_state).toBe("ROLLBACK");
      expect(applyInNoGit.failure.failure_reason).toContain("Not a git repository");
    });
  });

  test("e2e ingest -> flow -> night dry-run", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "PRD分析 UI生成 代码生成",
        conversation: "PRD分析 UI生成 代码生成",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");

      ingestCommand(inputFile);
      const flow = flowCommand();
      const night = JSON.parse(nightCommand({ dryRun: true, timeBudget: 1 }));

      expect(flow).toContain("下一步建议");
      expect(night.final_state).toBe("GATE");
    });
  });
});
