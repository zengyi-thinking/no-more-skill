#!/usr/bin/env node
import { runSkillRoute } from "./skill-router.js";

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
  process.stderr.write("Usage: nms-skill /nms-flow [--format json]\n");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(3));
const result = runSkillRoute({ slashCommand, args });
process.stdout.write(`${result}\n`);

