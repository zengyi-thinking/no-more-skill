#!/usr/bin/env node
import { Command } from "commander";
import {
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  ingestCommand,
  nightCommand,
  replayCommand
} from "./commands.js";

const program = new Command();
program.name("nms").description("No More Skill - behavior engineering CLI").version("0.2.0");

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
  .action((opts) => {
    if (Boolean(opts.visual)) {
      const outPath = flowVisualCommand();
      process.stdout.write(`Visual dashboard generated: ${outPath}\n`);
      return;
    }
    const format = opts.format === "json" ? "json" : "human";
    process.stdout.write(`${flowCommand(format)}\n`);
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

program.parse();
