#!/usr/bin/env node
import { Command } from "commander";
import {
  autoCommand,
  birthdayCommand,
  briefCommand,
  contextCommand,
  dataStatusCommand,
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  guardCommand,
  guardPendingCommand,
  ingestGuideCommand,
  ingestCommand,
  nightCommand,
  onboardingCommand,
  profileReviewCommand,
  reportCommand,
  replayCommand,
  suggestCommand
} from "./commands.js";
import { runSkillRoute } from "./skill-router.js";

const program = new Command();
program.name("nms").description("No More Skill - behavior engineering CLI").version("0.4.5");

program.action(() => {
  process.stdout.write(`${onboardingCommand()}\n`);
});

program
  .command("ingest", { hidden: true })
  .description("ingest compressed context payload from file or stdin")
  .option("-i, --input <file>", "input JSON file path")
  .action((opts) => {
    if (!opts.input && process.stdin.isTTY) {
      process.stdout.write(`${ingestGuideCommand()}\n`);
      return;
    }
    const out = ingestCommand(opts.input);
    process.stdout.write(`${out}\n`);
  });

program
  .command("flow")
  .description("show professional behavior dashboard")
  .option("--format <type>", "human or json", "human")
  .option("--visual", "generate HTML visual dashboard")
  .option("--domain <name>", "filter dashboard by behavior domain")
  .action((opts) => {
    if (Boolean(opts.visual)) {
      const outPath = flowVisualCommand();
      process.stdout.write(`Visual dashboard generated: ${outPath}\n`);
      return;
    }
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${flowCommand(format, { domain: opts.domain })}\n`);
  });

program
  .command("context", { hidden: true })
  .description("export agent-readable user behavior context")
  .option("--task <text>", "task summary")
  .option("--task-file <file>", "task text file")
  .option("--format <type>", "human or json", "human")
  .option("--include-evidence", "include evidence refs metadata")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(
      `${contextCommand({
        task: opts.task,
        taskFile: opts.taskFile,
        format,
        includeEvidence: Boolean(opts.includeEvidence)
      })}\n`
    );
  });

program
  .command("brief", { hidden: true })
  .description("generate a compact agent brief from .nms context")
  .option("--task <text>", "task summary")
  .option("--task-file <file>", "task text file")
  .option("--format <type>", "markdown or json", "markdown")
  .option("--profile <type>", "compact, full, or strict", "compact")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "markdown";
    const profile = ["full", "strict"].includes(opts.profile) ? opts.profile : "compact";
    process.stdout.write(`${briefCommand({ task: opts.task, taskFile: opts.taskFile, format, profile })}\n`);
  });

program
  .command("suggest", { hidden: true })
  .description("suggest a workflow for a task from history/domain packs")
  .option("--task <text>", "task summary")
  .option("--task-file <file>", "task text file")
  .option("--format <type>", "human or json", "human")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${suggestCommand({ task: opts.task, taskFile: opts.taskFile, format })}\n`);
  });

program
  .command("auto")
  .description("run the user-facing guarded dry-run automation entry")
  .option("--format <type>", "human or json", "human")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${autoCommand(format)}\n`);
  });

program
  .command("birthday")
  .description("generate a living birthday memory capsule and report")
  .option("--format <type>", "human or json", "human")
  .option("--image", "generate a birthday poster via relay url/apikey")
  .option("--output-dir <dir>", "birthday report output directory")
  .option("--base-url <url>", "image relay endpoint url")
  .option("--api-key <key>", "image relay API key")
  .option("--model <name>", "image model, default gpt-image-2")
  .action(async (opts) => {
    const format = opts.format === "json" ? "json" : "human";
    const out = await birthdayCommand({
      format,
      image: Boolean(opts.image),
      outputDir: opts.outputDir,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model
    });
    process.stdout.write(`${out}\n`);
  });

program
  .command("guard", { hidden: true })
  .description("check write policy for files before an agent edits")
  .argument("[files...]", "files to check")
  .option("--format <type>", "human or json", "human")
  .action((files, opts) => {
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${files.length > 0 ? guardCommand(files, format) : guardPendingCommand(format)}\n`);
  });

program
  .command("replay", { hidden: true })
  .description("replay the most common workflow")
  .action(() => {
    process.stdout.write(`${replayCommand()}\n`);
  });

program
  .command("night", { hidden: true })
  .description("run night harness with real task input; default dry-run")
  .option("--dry-run", "force dry run mode")
  .option("--apply", "enable write/apply mode explicitly")
  .option("--explain", "show gate decision chain")
  .option("--task <text>", "auto-plan a dry-run task")
  .option("--task-file <file>", "planner JSON file path")
  .option("--resume <id>", "resume/read a previous night-run artifact")
  .option("--time-budget <min>", "time budget in minutes", "5")
  .action((opts) => {
    const out = nightCommand({
      dryRun: Boolean(opts.dryRun),
      apply: Boolean(opts.apply),
      explain: Boolean(opts.explain),
      task: opts.task,
      taskFile: opts.taskFile,
      resume: opts.resume,
      timeBudget: Number(opts.timeBudget)
    });
    process.stdout.write(`${out}\n`);
  });

program
  .command("doctor", { hidden: true })
  .description("read-only diagnostics for data and git safety")
  .action(() => {
    process.stdout.write(`${doctorCommand()}\n`);
  });

program
  .command("data", { hidden: true })
  .description("inspect .nms behavior data")
  .argument("[action]", "status", "status")
  .option("--format <type>", "human or json", "human")
  .action((action, opts) => {
    if (action !== "status") {
      process.stdout.write(`Unsupported data action: ${action}\n`);
      return;
    }
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${dataStatusCommand(format)}\n`);
  });

program
  .command("profile", { hidden: true })
  .description("review learned user profile claims")
  .option("--review", "review profile claims", true)
  .option("--format <type>", "human or json", "human")
  .action((opts) => {
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${profileReviewCommand(format)}\n`);
  });

program
  .command("route", { hidden: true })
  .description("agent-friendly route entry for slash-style invocation")
  .requiredOption("--cmd <slash>", "slash command, e.g. /nms-flow")
  .option("--args-json <json>", "json object for command args", "{}")
  .action(async (opts) => {
    const parsedArgs = JSON.parse(String(opts.argsJson ?? "{}")) as Record<
      string,
      string | boolean | number | undefined
    >;
    const out = await runSkillRoute({ slashCommand: String(opts.cmd), args: parsedArgs });
    process.stdout.write(`${out}\n`);
  });

program
  .command("report")
  .description("generate NMS progress report and optional relay images")
  .option("--image", "generate images via relay url/apikey")
  .option("--output-dir <dir>", "report output directory")
  .option("--base-url <url>", "image relay endpoint url")
  .option("--api-key <key>", "image relay API key")
  .option("--model <name>", "image model, default gpt-image-2")
  .option("--format <type>", "md, html, or json", "html")
  .option("--period <range>", "report period, e.g. 1d or 7d", "7d")
  .option("--template <name>", "daily, weekly, video, or portfolio", "weekly")
  .option("--real-only", "only use real .nms data", true)
  .action(async (opts) => {
    const format = ["html", "json"].includes(opts.format) ? opts.format : "md";
    const out = await reportCommand({
      image: Boolean(opts.image),
      outputDir: opts.outputDir,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      format,
      period: opts.period,
      template: opts.template,
      realOnly: Boolean(opts.realOnly)
    });
    process.stdout.write(`Report generated: ${out}\n`);
  });

program.parse();
