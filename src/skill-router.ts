import {
  autoCommand,
  birthdayCommand,
  birthdayWishCommand,
  briefCommand,
  contextCommand,
  dataStatusCommand,
  doctorCommand,
  flowCommand,
  flowVisualCommand,
  guardCommand,
  guardPendingCommand,
  hostsCommand,
  ingestGuideCommand,
  ingestCommand,
  ingestWatchCommand,
  nightCommand,
  onboardingCommand,
  profileReviewCommand,
  reportCommand,
  replayCommand,
  suggestCommand
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
      return onboardingCommand((args.format as "human" | "json") ?? "human");
    case "/nms-ingest":
      if (args.watch) return ingestWatchCommand(args.watch as string | undefined);
      if (!args.input) return ingestGuideCommand();
      return ingestCommand(args.input as string | undefined);
    case "/nms-auto":
      return autoCommand((args.format as "human" | "json") ?? "human");
    case "/nms-birthday":
      return birthdayCommand({
        format: (args.format as "human" | "json") ?? "human",
        image: toBool(args.image),
        outputDir: args["output-dir"] as string | undefined,
        baseUrl: args["base-url"] as string | undefined,
        apiKey: args["api-key"] as string | undefined,
        model: args.model as string | undefined
      });
    case "/nms-birthday-wish":
      return birthdayWishCommand({
        wishText: (args.wish as string | undefined) ?? (args.text as string | undefined),
        source: (args.source as "user" | "agent") ?? "user",
        horizon: (args.horizon as "30d" | "90d" | "1y") ?? "90d",
        format: (args.format as "human" | "json") ?? "human",
        outputDir: args["output-dir"] as string | undefined
      });
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
    case "/nms-brief":
      return briefCommand({
        task: args.task as string | undefined,
        taskFile: (args["task-file"] as string | undefined) ?? (args.taskFile as string | undefined),
        format: (args.format as "markdown" | "json") ?? "markdown",
        profile: (args.profile as "compact" | "full" | "strict") ?? "strict"
      });
    case "/nms-suggest":
      return suggestCommand({
        task: args.task as string | undefined,
        taskFile: (args["task-file"] as string | undefined) ?? (args.taskFile as string | undefined),
        format: (args.format as "human" | "json") ?? "human"
      });
    case "/nms-guard": {
      const rawFiles = args.files ?? args.file ?? "";
      const files = Array.isArray(rawFiles)
        ? rawFiles.map(String)
        : String(rawFiles).split(",").map((item) => item.trim()).filter(Boolean);
      return files.length > 0
        ? guardCommand(
            files,
            (args.format as "human" | "json") ?? "human",
            (args["policy-profile"] as "strict" | "normal" | "experimental") ?? "normal"
          )
        : guardPendingCommand(
            (args.format as "human" | "json") ?? "human",
            (args["policy-profile"] as "strict" | "normal" | "experimental") ?? "normal"
          );
    }
    case "/nms-replay":
      return replayCommand();
    case "/nms-night":
      return nightCommand({
        dryRun: toBool(args["dry-run"]) || toBool(args.dryRun),
        apply: toBool(args.apply),
        explain: toBool(args.explain),
        task: args.task as string | undefined,
        taskFile: (args["task-file"] as string | undefined) ?? (args.taskFile as string | undefined),
        resume: args.resume as string | undefined,
        timeBudget: toNum(args["time-budget"] ?? args.timeBudget, 5),
        policyProfile: (args["policy-profile"] as "strict" | "normal" | "experimental") ?? "strict"
      });
    case "/nms-report": {
      const reportPath = await reportCommand({
        image: toBool(args.image),
        outputDir: args["output-dir"] as string | undefined,
        baseUrl: args["base-url"] as string | undefined,
        apiKey: args["api-key"] as string | undefined,
        model: args.model as string | undefined,
        format: (args.format as "md" | "html" | "json") ?? "html",
        period: args.period as string | undefined,
        template: args.template as string | undefined,
        realOnly: args["real-only"] === undefined && args.realOnly === undefined
          ? true
          : toBool(args["real-only"]) || toBool(args.realOnly)
      });
      return `Report generated: ${reportPath}`;
    }
    case "/nms-doctor":
      return doctorCommand();
    case "/nms-hosts":
      return hostsCommand((args.format as "human" | "json") ?? "human", {
        probe: toBool(args.probe),
        writeCommands: toBool(args["write-commands"]) || toBool(args.writeCommands)
      });
    case "/nms-data":
      return dataStatusCommand((args.format as "human" | "json") ?? "human");
    case "/nms-profile":
      return profileReviewCommand((args.format as "human" | "json") ?? "human");
    default:
      return [
        `Unsupported slash command: ${cmd}`,
        "",
        onboardingCommand("human")
      ].join("\n");
  }
}
