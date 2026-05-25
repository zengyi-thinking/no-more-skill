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
  const rawCmd = input.slashCommand.trim();
  const cmd = (() => {
    if (rawCmd.startsWith("/") || rawCmd.startsWith("$")) return rawCmd;
    if (rawCmd.startsWith("nms:")) return `/${rawCmd}`;
    if (rawCmd.startsWith("nms-")) return `/${rawCmd}`;
    if (rawCmd === "nms") return "/nms";
    return rawCmd;
  })();
  const args = input.args;

  const helpText = [
    "NMS Skill Commands:",
    "- /nms [flow|ingest|replay|night|doctor|report] [flags]",
    "- /nms-flow [--format human|json] [--visual]",
    "- /nms-context --task <task> [--format json]",
    "- /nms-ingest --input <file>",
    "- /nms-replay",
    "- /nms-night --dry-run --task-file <task.json> [--explain]",
    "- /nms-night --apply --task-file <task.json>",
    "- /nms-doctor",
    "- /nms-report [--image]"
  ].join("\n");

  const canonical = (() => {
    if (cmd === "/nms" || cmd === "$nms") {
      const action = String(args.action ?? args.cmd ?? args.sub ?? args.command ?? "help").toLowerCase();
      if (action === "help" || action === "h") return "/nms-help";
      return `/nms-${action}`;
    }
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
    case "/nms-help":
      return helpText;
    case "/nms-ingest":
      return ingestCommand(args.input as string | undefined);
    case "/nms-flow":
      if (toBool(args.visual)) {
        const out = flowVisualCommand();
        return `Visual dashboard generated: ${out}`;
      }
      return flowCommand((args.format as "human" | "json") ?? "human", {
        domain: args.domain as string | undefined
      });
    case "/nms-context":
      return contextCommand({
        task: args.task as string | undefined,
        taskFile: (args["task-file"] as string | undefined) ?? (args.taskFile as string | undefined),
        format: (args.format as "human" | "json") ?? "human",
        includeEvidence: toBool(args["include-evidence"]) || toBool(args.includeEvidence)
      });
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
        model: args.model as string | undefined,
        format: (args.format as "md" | "html" | "json") ?? "md",
        period: args.period as string | undefined,
        realOnly: args["real-only"] === undefined && args.realOnly === undefined
          ? true
          : toBool(args["real-only"]) || toBool(args.realOnly)
      });
      return `Report generated: ${reportPath}`;
    }
    case "/nms-doctor":
      return doctorCommand();
    default:
      return `Unsupported slash command: ${cmd}\n\n${helpText}`;
  }
}
