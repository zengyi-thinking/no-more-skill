import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  ingestCommand,
  nightCommand,
  replayCommand
} from "../src/commands.js";
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

describe.sequential("NMS v0.2 optimization", () => {
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
      expect(emptyFlow).toContain("Recent Workflow");
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
      expect(flow).toContain("Top Skills");
      const flowJson = JSON.parse(flowCommand("json"));
      expect(flowJson.quality).toBeDefined();
      expect(flowJson.next_suggestions.length).toBeGreaterThan(0);
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
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "real dry-run validation",
          files: ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
          constraints: ["ui/new/tests only"],
          test_plan: []
        }),
        "utf8"
      );
      const out = JSON.parse(
        nightCommand({ dryRun: true, timeBudget: 1, explain: true, taskFile })
      );
      expect(out.dry_run).toBe(true);
      expect(out.logs.join(" ")).toContain("State=PLAN");
      expect(out.logs.join(" ")).toContain("State=GATE");
      expect(out.state_logs.length).toBeGreaterThan(0);
      expect(out.explain_chain.length).toBeGreaterThan(0);
    });
  });

  test("night apply is blocked by default and safety checks", () => {
    withTempCwd(() => {
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "real apply validation",
          files: ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
          constraints: ["ui/new/tests only"],
          test_plan: []
        }),
        "utf8"
      );
      const dry = JSON.parse(nightCommand({ taskFile }));
      expect(dry.dry_run).toBe(true);

      const applyInNoGit = JSON.parse(nightCommand({ apply: true, taskFile }));
      expect(applyInNoGit.final_state).toBe("ROLLBACK");
      expect(applyInNoGit.failure.failure_reason).toContain("Not a git repository");
      expect(applyInNoGit.failure.code).toBe("CONFIG_ERROR");
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
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "e2e dry-run",
          files: ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
          constraints: ["ui/new/tests only"],
          test_plan: []
        }),
        "utf8"
      );
      const night = JSON.parse(
        nightCommand({ dryRun: true, timeBudget: 1, explain: true, taskFile })
      );
      const doctor = doctorCommand();

      expect(flow).toContain("Actionable Suggestions");
      expect(night.final_state).toBe("GATE");
      expect(doctor).toContain("NMS Doctor");
    });
  });

  test("night without task-file returns config error", () => {
    withTempCwd(() => {
      const out = JSON.parse(nightCommand({ dryRun: true, explain: true }));
      expect(out.final_state).toBe("ROLLBACK");
      expect(out.failure.code).toBe("CONFIG_ERROR");
      expect(out.failure.failure_reason).toContain("Missing planner input");
    });
  });

  test("schema auto migrates to v2 and stores perf window fields", () => {
    withTempCwd(() => {
      const oldDbPath = path.join(process.cwd(), ".nms");
      fs.mkdirSync(oldDbPath, { recursive: true });
      fs.writeFileSync(
        path.join(oldDbPath, "data.json"),
        JSON.stringify({
          schema_version: 1,
          sessions: [],
          stats: { skill_counts: {}, workflow_counts: {}, last_updated: new Date().toISOString() },
          user_profile: { style: "unknown", top_skills: [], top_workflows: [], updated_at: new Date().toISOString() }
        }),
        "utf8"
      );
      const doctor = doctorCommand();
      expect(doctor).toContain("Schema Version");
      const db = JSON.parse(fs.readFileSync(path.join(oldDbPath, "data.json"), "utf8"));
      expect(db.schema_version).toBe(2);
      expect(db.stats.perf_windows).toBeDefined();
    });
  });

  test("flow visual generates html dashboard file", () => {
    withTempCwd(() => {
      const file = flowVisualCommand();
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("NMS 行为驾驶舱");
      expect(content).toContain("<html");
    });
  });
});
