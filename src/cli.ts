#!/usr/bin/env node
import { Command } from "commander";
import { flowCommand, ingestCommand, nightCommand, replayCommand } from "./commands.js";

const program = new Command();
program.name("nms").description("No More Skill - behavior engineering CLI").version("0.1.0");

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
  .description("show recent workflow, top skills, idle skills, and next suggestion")
  .action(() => {
    process.stdout.write(`${flowCommand()}\n`);
  });

program
  .command("replay")
  .description("replay the most common workflow")
  .action(() => {
    process.stdout.write(`${replayCommand()}\n`);
  });

program
  .command("night")
  .description("run night harness; default dry-run")
  .option("--dry-run", "force dry run mode")
  .option("--apply", "enable write/apply mode explicitly")
  .option("--time-budget <min>", "time budget in minutes", "5")
  .action((opts) => {
    const out = nightCommand({
      dryRun: Boolean(opts.dryRun),
      apply: Boolean(opts.apply),
      timeBudget: Number(opts.timeBudget)
    });
    process.stdout.write(`${out}\n`);
  });

program.parse();
