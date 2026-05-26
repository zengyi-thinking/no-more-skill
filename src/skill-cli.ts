#!/usr/bin/env node
import { runSkillRoute } from "./skill-router.js";
import { onboardingCommand } from "./commands.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const slashCommand = process.argv[2];
if (!slashCommand) {
  process.stdout.write(`${onboardingCommand()}\n`);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(3));
const result = await runSkillRoute({ slashCommand, args });
process.stdout.write(`${result}\n`);
