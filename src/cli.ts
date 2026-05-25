#!/usr/bin/env node
import { Command } from "commander";
import {
  contextCommand,
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  ingestCommand,
  nightCommand,
  reportCommand,
  replayCommand
} from "./commands.js";
import { runSkillRoute } from "./skill-router.js";

const program = new Command();
program.name("nms").description("No More Skill - behavior engineering CLI").version("0.3.0");

program
  .command("ingest")
  .description("ingest compressed context payload from file or stdin")
  .option("-i, --input <file>", "input JSON file path")
  .action((opts) => {
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
  .command("context")
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
  .command("replay")
  .description("replay the most common workflow")
  .action(() => {
    process.stdout.write(`${replayCommand()}\n`);
  });

program
  .command("night")
  .description("run night harness with real task input; default dry-run")
  .option("--dry-run", "force dry run mode")
  .option("--apply", "enable write/apply mode explicitly")
  .option("--explain", "show gate decision chain")
  .option("--task-file <file>", "planner JSON file path")
  .option("--time-budget <min>", "time budget in minutes", "5")
  .action((opts) => {
    const out = nightCommand({
      dryRun: Boolean(opts.dryRun),
      apply: Boolean(opts.apply),
      explain: Boolean(opts.explain),
      taskFile: opts.taskFile,
      timeBudget: Number(opts.timeBudget)
    });
    process.stdout.write(`${out}\n`);
  });

program
  .command("doctor")
  .description("read-only diagnostics for data and git safety")
  .action(() => {
    process.stdout.write(`${doctorCommand()}\n`);
  });

program
  .command("route")
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
  .option("--format <type>", "md, html, or json", "md")
  .option("--period <range>", "report period, e.g. 1d or 7d", "7d")
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
      realOnly: Boolean(opts.realOnly)
    });
    process.stdout.write(`Report generated: ${out}\n`);
  });

program.parse();
