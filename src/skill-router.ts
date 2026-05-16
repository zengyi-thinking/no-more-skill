import {
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  ingestCommand,
  nightCommand,
  reportCommand,
  replayCommand
} from "./commands.js";

export interface SkillRouteInput {
  slashCommand: string;
  args: Record<string, string | boolean | number | undefined>;
}

function toBool(v: string | boolean | number | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return false;
}

function toNum(v: string | boolean | number | undefined, fallback: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export async function runSkillRoute(input: SkillRouteInput): Promise<string> {
  const cmd = input.slashCommand.trim();
  const args = input.args;

  const canonical = (() => {
    if (cmd.startsWith("$nms-")) {
      return `/${cmd.slice(1)}`;
    }
    if (cmd.startsWith("$nms:")) {
      return `/nms-${cmd.slice("$nms:".length)}`;
    }
    if (cmd.startsWith("/nms:")) {
      return `/nms-${cmd.slice("/nms:".length)}`;
    }
    return cmd;
  })();

  switch (canonical) {
    case "/nms-ingest":
      return ingestCommand(args.input as string | undefined);
    case "/nms-flow":
      if (toBool(args.visual)) {
        const out = flowVisualCommand();
        return `Visual dashboard generated: ${out}`;
      }
      return flowCommand((args.format as "human" | "json") ?? "human");
    case "/nms-replay":
      return replayCommand();
    case "/nms-night":
      return nightCommand({
        dryRun: toBool(args["dry-run"]) || toBool(args.dryRun),
        apply: toBool(args.apply),
        explain: toBool(args.explain),
        taskFile: (args["task-file"] as string | undefined) ?? (args.taskFile as string | undefined),
        timeBudget: toNum(args["time-budget"] ?? args.timeBudget, 5)
      });
    case "/nms-report": {
      const reportPath = await reportCommand({
        image: toBool(args.image),
        outputDir: args["output-dir"] as string | undefined,
        baseUrl: args["base-url"] as string | undefined,
        apiKey: args["api-key"] as string | undefined,
        model: args.model as string | undefined
      });
      return `Report generated: ${reportPath}`;
    }
    case "/nms-doctor":
      return doctorCommand();
    default:
      return `Unsupported slash command: ${cmd}`;
  }
}
