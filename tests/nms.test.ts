import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  contextCommand,
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  ingestCommand,
  nightCommand,
  reportCommand,
  replayCommand
} from "../src/commands.js";
import { cleanSessions } from "../src/hook/cleaner.js";
import { runSkillRoute } from "../src/skill-router.js";
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
      const duplicateOut = JSON.parse(ingestCommand(inputFile));

      const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".nms", "data.json"), "utf8"));
      expect(db.sessions.length).toBe(1);
      expect(db.sessions[0].skills_used).toContain("PRD分析");
      expect(db.sessions[0].skills_used).toContain("代码生成");
      expect(duplicateOut.compressed_text).toBeUndefined();
      expect(duplicateOut.conversation).toBeUndefined();
    });
  });

  test("ingest accepts opencode as a source tool", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "PRD分析 代码生成",
        conversation: "opencode 先 PRD分析 再 代码生成",
        tool: "opencode"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");

      ingestCommand(inputFile);

      const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".nms", "data.json"), "utf8"));
      expect(db.sessions[0].tool).toBe("opencode");
    });
  });

  test("ingest uses real domain packs for non-coding behavior", () => {
    withTempCwd(() => {
      const domainDir = path.join(process.cwd(), ".nms", "domains");
      fs.mkdirSync(domainDir, { recursive: true });
      fs.writeFileSync(
        path.join(domainDir, "fitness.json"),
        JSON.stringify({
          domain: "fitness",
          skills: {
            "准备类": ["热身"],
            "执行类": ["训练"],
            "复盘类": ["运动复盘"]
          },
          workflow_templates: [["热身", "训练", "运动复盘"]],
          style_signals: [{ name: "身体训练", patterns: ["力量", "体能"] }]
        }),
        "utf8"
      );
      const payload = {
        compressed_text: "今天先 热身，再 训练，最后做 运动复盘",
        conversation: "力量训练流程：热身 -> 训练 -> 运动复盘",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");

      ingestCommand(inputFile);

      const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".nms", "data.json"), "utf8"));
      expect(db.sessions[0].domain).toBe("fitness");
      expect(db.sessions[0].skills_used).toEqual(["热身", "训练", "运动复盘"]);
      expect(db.stats.domain_counts.fitness).toBe(1);

      const flowJson = JSON.parse(flowCommand("json", { domain: "fitness" }));
      expect(flowJson.top_skills).toContain("热身(1)");
      expect(flowJson.domain_summary[0]).toEqual({ name: "fitness", count: 1 });
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
          test_plan: ["node -e \"process.exit(0)\""]
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
          test_plan: ["node -e \"process.exit(0)\""]
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
          test_plan: ["node -e \"process.exit(0)\""]
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

  test("night does not allow skipping test phase", () => {
    withTempCwd(() => {
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "missing tests should rollback",
          files: ["sandbox/new/widget.tsx"],
          constraints: ["ui/new/tests only"],
          test_plan: []
        }),
        "utf8"
      );
      const out = JSON.parse(nightCommand({ dryRun: true, timeBudget: 1, explain: true, taskFile }));
      expect(out.final_state).toBe("ROLLBACK");
      expect(out.failure.code).toBe("TEST_FAIL");
      expect(out.state_logs.some((entry: { state: string; decision: string }) => entry.state === "TEST" && entry.decision === "failed")).toBe(true);
    });
  });

  test("schema auto migrates to v3 and writes v3 layout", () => {
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
      expect(db.schema_version).toBe(3);
      expect(db.stats.perf_windows).toBeDefined();
      expect(fs.existsSync(path.join(oldDbPath, "events"))).toBe(true);
      expect(fs.existsSync(path.join(oldDbPath, "sessions"))).toBe(true);
      expect(fs.existsSync(path.join(oldDbPath, "derived", "stats.json"))).toBe(true);
      expect(fs.existsSync(path.join(oldDbPath, "backups"))).toBe(true);
    });
  });

  test("ingest redacts secrets and v3 session artifacts keep evidence", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "PRD分析 api_key=abc123 sk-secretSECRET123456",
        conversation: "先 PRD分析 再 代码生成 Bearer abc.def.ghi",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");

      ingestCommand(inputFile);

      const dbText = fs.readFileSync(path.join(process.cwd(), ".nms", "data.json"), "utf8");
      expect(dbText).not.toContain("abc123");
      expect(dbText).not.toContain("secretSECRET123456");
      expect(dbText).not.toContain("abc.def.ghi");

      const sessionDirs = path.join(process.cwd(), ".nms", "sessions");
      const sessionFile = fs
        .readdirSync(sessionDirs, { recursive: true })
        .map((p) => path.join(sessionDirs, String(p)))
        .find((p) => p.endsWith(".json"));
      expect(sessionFile).toBeTruthy();
      const session = JSON.parse(fs.readFileSync(sessionFile!, "utf8"));
      expect(session.skills[0].category).toBe("分析类");
      expect(session.workflow.confidence).toBeGreaterThan(0);
    });
  });

  test("context command returns agent-readable json and artifact record", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "PRD分析 UI生成 代码生成",
        conversation: "先 PRD分析 再 UI生成 最后 代码生成",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");
      ingestCommand(inputFile);

      const out = JSON.parse(contextCommand({ task: "生成项目周报", format: "json" }));
      expect(out.user_style.avoid).toContain("demo 数据");
      expect(out.safety_policy.requires_explicit_apply).toBe(true);
      expect(out.data_quality.sample_count).toBe(1);
      expect(out.relevant_domains[0].name).toBe("coding");
      expect(fs.existsSync(path.join(process.cwd(), ".nms", "artifacts", "artifacts.json"))).toBe(true);
    });
  });

  test("v3 sessions can rebuild compatibility data when data.json is missing", () => {
    withTempCwd(() => {
      const payload = {
        compressed_text: "PRD分析 UI生成",
        conversation: "先 PRD分析 再 UI生成",
        tool: "codex"
      };
      const inputFile = path.join(process.cwd(), "input.json");
      fs.writeFileSync(inputFile, JSON.stringify(payload), "utf8");
      ingestCommand(inputFile);
      fs.unlinkSync(path.join(process.cwd(), ".nms", "data.json"));

      const flowJson = JSON.parse(flowCommand("json"));
      expect(flowJson.top_skills.join(",")).toContain("PRD分析");
      expect(fs.existsSync(path.join(process.cwd(), ".nms", "data.json"))).toBe(true);
    });
  });

  test("report html uses real samples and registers report artifact", async () => {
    await (async () => {
      const old = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
      process.chdir(dir);
      try {
        const reportPath = await reportCommand({ format: "html", realOnly: true, period: "7d" });
        expect(reportPath.endsWith("report.html")).toBe(true);
        const content = fs.readFileSync(reportPath, "utf8");
        expect(content).toContain("真实样本");
        expect(content).toContain("样本不足");
        expect(content).toContain("领域分布");
        expect(content).toContain("Workflow 排名与转移边");
        const registry = JSON.parse(
          fs.readFileSync(path.join(process.cwd(), ".nms", "artifacts", "artifacts.json"), "utf8")
        );
        expect(registry.some((item: { type: string; real_data_only: boolean }) => item.type === "report" && item.real_data_only)).toBe(true);
        expect(reportPath).toContain(path.join(".nms", "artifacts", "reports", "latest"));
        const eventsFile = fs.readdirSync(path.join(process.cwd(), ".nms", "events"))[0];
        const eventsText = fs.readFileSync(path.join(process.cwd(), ".nms", "events", eventsFile), "utf8");
        expect(eventsText).toContain("REPORT_GENERATED");
      } finally {
        process.chdir(old);
      }
    })();
  });

  test("report period filters real sessions instead of using all history", async () => {
    await (async () => {
      const old = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
      process.chdir(dir);
      try {
        const first = path.join(process.cwd(), "first.json");
        const second = path.join(process.cwd(), "second.json");
        fs.writeFileSync(
          first,
          JSON.stringify({
            compressed_text: "PRD分析",
            conversation: "旧任务只做 PRD分析",
            tool: "codex"
          }),
          "utf8"
        );
        fs.writeFileSync(
          second,
          JSON.stringify({
            compressed_text: "UI生成",
            conversation: "近期任务只做 UI生成",
            tool: "codex"
          }),
          "utf8"
        );
        ingestCommand(first);
        ingestCommand(second);
        const dbPath = path.join(process.cwd(), ".nms", "data.json");
        const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
        db.sessions[0].created_at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");

        const reportPath = await reportCommand({ format: "json", realOnly: true, period: "7d" });
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        expect(report.sample_count).toBe(1);
        expect(report.top_skills).toEqual([["UI生成", 1]]);
      } finally {
        process.chdir(old);
      }
    })();
  });

  test("night rollback is non-destructive on review failure", () => {
    withTempCwd(() => {
      fs.mkdirSync("sandbox/new", { recursive: true });
      fs.writeFileSync("sandbox/new/keep.tsx", "user local change", "utf8");
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "review fail should not reset files",
          files: ["sandbox/new/keep.tsx"],
          constraints: [],
          test_plan: ["node -e \"process.exit(0)\""]
        }),
        "utf8"
      );
      const out = JSON.parse(nightCommand({ dryRun: true, timeBudget: 1, explain: true, taskFile }));
      expect(out.final_state).toBe("ROLLBACK");
      expect(out.failure.code).toBe("REVIEW_FAIL");
      expect(fs.readFileSync("sandbox/new/keep.tsx", "utf8")).toBe("user local change");
      expect(out.policy_logs.some((log: { name: string }) => log.name === "write_scope_guard")).toBe(true);
    });
  });

  test("night apply commits from isolated worktree without switching current branch", () => {
    withTempCwd(() => {
      execSync("git init", { stdio: "pipe" });
      execSync("git config user.email test@example.com", { stdio: "pipe" });
      execSync("git config user.name Tester", { stdio: "pipe" });
      fs.writeFileSync("README.md", "seed", "utf8");
      execSync("git add README.md && git commit -m seed", { stdio: "pipe" });
      execSync("git checkout -b feature/current", { stdio: "pipe" });
      fs.mkdirSync("sandbox/new", { recursive: true });
      fs.writeFileSync("sandbox/new/widget.tsx", "export const widget = true;\n", "utf8");
      fs.writeFileSync("sandbox/new/widget.test.ts", "export const test = true;\n", "utf8");
      const taskFile = path.join(process.cwd(), "task.json");
      fs.writeFileSync(
        taskFile,
        JSON.stringify({
          task: "isolated apply",
          files: ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
          constraints: ["ui/new/tests only"],
          test_plan: ["node -e \"process.exit(0)\""]
        }),
        "utf8"
      );

      const out = JSON.parse(nightCommand({ apply: true, timeBudget: 1, explain: true, taskFile }));
      const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
      const status = execSync("git status --short").toString();

      expect(out.final_state).toBe("COMMIT");
      expect(branch).toBe("feature/current");
      expect(status).toContain("?? sandbox/");
      expect(status).not.toContain("A  sandbox/");
      expect(out.policy_logs.some((log: { name: string }) => log.name === "isolated_worktree_guard")).toBe(true);
    });
  }, 15000);

  test("flow visual generates html dashboard file", () => {
    withTempCwd(() => {
      const file = flowVisualCommand();
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("NMS 行为驾驶舱");
      expect(content).toContain("<html");
    });
  });

  test("slash router maps /nms-flow and /nms-doctor", async () => {
    await (async () => {
      const old = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
      process.chdir(dir);
      try {
        const flow = await runSkillRoute({ slashCommand: "/nms-flow", args: { format: "human" } });
        expect(flow).toContain("Behavior Cockpit");
        const doctor = await runSkillRoute({ slashCommand: "/nms-doctor", args: {} });
        expect(doctor).toContain("NMS Doctor");
      const flowColon = await runSkillRoute({
        slashCommand: "/nms:flow",
        args: { format: "human" }
      });
      expect(flowColon).toContain("Behavior Cockpit");
      const flowCodex = await runSkillRoute({
        slashCommand: "$nms-flow",
        args: { format: "human" }
      });
      expect(flowCodex).toContain("Behavior Cockpit");
      const flowUnified = await runSkillRoute({
        slashCommand: "/nms",
        args: { action: "flow", format: "human" }
      });
      expect(flowUnified).toContain("Behavior Cockpit");
      const flowNoSlash = await runSkillRoute({
        slashCommand: "nms-flow",
        args: { format: "human" }
      });
      expect(flowNoSlash).toContain("Behavior Cockpit");
      const helpUnified = await runSkillRoute({
        slashCommand: "/nms",
        args: {}
      });
      expect(helpUnified).toContain("NMS Skill Commands");
    } finally {
        process.chdir(old);
      }
    })();
  });

  test("slash router maps /nms-night with task-file", async () => {
    await (async () => {
      const old = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
      process.chdir(dir);
      try {
        const taskFile = path.join(process.cwd(), "task.json");
        fs.writeFileSync(
          taskFile,
          JSON.stringify({
            task: "slash night check",
            files: ["sandbox/new/widget.tsx", "sandbox/new/widget.test.ts"],
            constraints: ["ui/new/tests only"],
            test_plan: ["node -e \"process.exit(0)\""]
          }),
          "utf8"
        );
        const out = await runSkillRoute({
          slashCommand: "/nms-night",
          args: { "dry-run": true, explain: true, "task-file": taskFile }
        });
        expect(out).toContain("\"final_state\": \"GATE\"");
      } finally {
        process.chdir(old);
      }
    })();
  });

  test("slash router maps /nms-report and writes markdown", async () => {
    await (async () => {
      const old = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nms-"));
      process.chdir(dir);
      try {
        const out = await runSkillRoute({
          slashCommand: "/nms-report",
          args: {}
        });
        expect(out).toContain("Report generated:");
        const reportPath = out.replace("Report generated: ", "").trim();
        expect(fs.existsSync(reportPath)).toBe(true);
        const content = fs.readFileSync(reportPath, "utf8");
        expect(content).toContain("NMS 可视化周报");
      } finally {
        process.chdir(old);
      }
    })();
  });
});
