import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type NmsHostName = "claude" | "codex" | "opencode";
export type NmsHostStatus = "ready" | "partial" | "missing";

export interface HostIntegration {
  name: NmsHostName;
  label: string;
  executable: string;
  executable_found: boolean;
  executable_path?: string;
  executable_probe?: {
    ok: boolean;
    output: string;
    skipped?: boolean;
  };
  skill_dir: string;
  skill_installed: boolean;
  runtime_file: string;
  runtime_installed: boolean;
  command_file?: string;
  command_installed?: boolean;
  invocation: string[];
  status: NmsHostStatus;
  fix_hint: string;
}

export interface HostIntegrationReport {
  generated_at: string;
  home_dir: string;
  hosts: HostIntegration[];
  summary: {
    ready: number;
    partial: number;
    missing: number;
  };
  recommended_user_commands: string[];
  repair_command: string;
}

interface DetectHostOptions {
  homeDir?: string;
  probeExecutables?: boolean;
}

interface WriteHostOptions {
  homeDir?: string;
}

const USER_COMMANDS = ["/nms", "/nms-flow", "/nms-report", "/nms-auto", "/nms-birthday", "/nms-birthday-wish"];

function homePath(homeDir: string, ...parts: string[]): string {
  return path.join(homeDir, ...parts);
}

function firstExistingPath(paths: string[]): string {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? paths[0];
}

function candidateRank(candidate: string): number {
  const ext = path.extname(candidate).toLowerCase();
  switch (ext) {
    case ".exe":
      return 40;
    case ".cmd":
      return 30;
    case ".bat":
      return 25;
    case ".ps1":
      return 20;
    default:
      return 10;
  }
}

function normalizeWindowsCandidates(candidates: string[]): string[] {
  const expanded = new Set<string>();
  for (const candidate of candidates) {
    expanded.add(candidate);
    if (!path.extname(candidate)) {
      const exeCandidate = `${candidate}.exe`;
      if (fs.existsSync(exeCandidate)) expanded.add(exeCandidate);
    }
  }
  return [...expanded];
}

function pickPreferredPath(candidates: string[]): string | undefined {
  return [...candidates]
    .sort((a, b) => candidateRank(b) - candidateRank(a) || a.localeCompare(b))[0];
}

function commandExists(command: string): { found: boolean; path?: string; candidates: string[] } {
  const lookup = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  try {
    const raw = execFileSync(lookup, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const candidates = process.platform === "win32" ? normalizeWindowsCandidates(raw) : raw;
    const preferred = pickPreferredPath(candidates);
    return { found: Boolean(preferred), path: preferred, candidates };
  } catch {
    return { found: false, candidates: [] };
  }
}

function probeCommand(command: string): HostIntegration["executable_probe"] {
  try {
    const out = execFileSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000
    }).trim();
    return { ok: true, output: out || "version command returned no output" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: message.split(/\r?\n/)[0] ?? "version probe failed" };
  }
}

function probeHost(
  host: NmsHostName,
  executablePath: string | undefined
): HostIntegration["executable_probe"] | undefined {
  if (!executablePath) return undefined;
  if (process.platform === "win32" && (host === "codex" || host === "opencode")) {
    return {
      ok: true,
      skipped: true,
      output: "Windows packaged host detected; probe skipped and readiness is verified from installation/runtime files."
    };
  }
  return probeCommand(executablePath);
}

function statusFor(
  found: boolean,
  skillInstalled: boolean,
  runtimeInstalled: boolean,
  commandInstalled: boolean | undefined
): NmsHostStatus {
  const commandOk = commandInstalled ?? true;
  if (found && skillInstalled && runtimeInstalled && commandOk) return "ready";
  if (found || skillInstalled || runtimeInstalled || commandOk === true) return "partial";
  return "missing";
}

function fixHint(host: NmsHostName, status: NmsHostStatus, runtimeInstalled: boolean): string {
  if (status === "ready") return "No action needed. Restart the host if the command palette was already open.";
  if (!runtimeInstalled) return "Reinstall or build NMS so dist/skill-cli.js exists, then run nms hosts --write-commands.";
  if (host === "codex") {
    return "Run npx skills add zengyi-thinking/no-more-skill, then call $nms-flow or mention no-more-skill.";
  }
  return "Run nms hosts --write-commands, then restart the host so /nms is re-indexed.";
}

function hostDefinitions(homeDir: string) {
  const claudeSkill = firstExistingPath([
    homePath(homeDir, ".claude", "skills", "no-more-skill"),
    homePath(homeDir, ".claude", "skills", "nms")
  ]);
  const codexSkill = firstExistingPath([
    homePath(homeDir, ".codex", "skills", "no-more-skill"),
    homePath(homeDir, ".codex", "skills", "nms")
  ]);
  const opencodeSkill = firstExistingPath([
    homePath(homeDir, ".config", "opencode", "skills", "no-more-skill"),
    homePath(homeDir, ".config", "opencode", "skills", "nms"),
    homePath(homeDir, ".opencode", "skills", "no-more-skill"),
    homePath(homeDir, ".opencode", "skills", "nms")
  ]);

  return [
    {
      name: "claude" as const,
      label: "Claude Code",
      executable: "claude",
      skill_dir: claudeSkill,
      command_file: homePath(homeDir, ".claude", "commands", "nms.md"),
      invocation: USER_COMMANDS
    },
    {
      name: "codex" as const,
      label: "Codex",
      executable: "codex",
      skill_dir: codexSkill,
      invocation: ["$nms-flow", "$nms-report", "$nms-auto", "$nms-birthday", "$nms-birthday-wish", "no-more-skill"]
    },
    {
      name: "opencode" as const,
      label: "OpenCode",
      executable: "opencode",
      skill_dir: opencodeSkill,
      command_file: homePath(homeDir, ".config", "opencode", "command", "nms.md"),
      invocation: USER_COMMANDS
    }
  ];
}

export function detectHostIntegrations(options: DetectHostOptions = {}): HostIntegrationReport {
  const homeDir = options.homeDir ?? os.homedir();
  const hosts = hostDefinitions(homeDir).map((definition) => {
    const executable = commandExists(definition.executable);
    const skillInstalled = fs.existsSync(path.join(definition.skill_dir, "SKILL.md"));
    const runtimeFile = path.join(definition.skill_dir, "dist", "skill-cli.js");
    const runtimeInstalled = fs.existsSync(runtimeFile);
    const commandInstalled = definition.command_file
      ? fs.existsSync(definition.command_file)
      : undefined;
    const probe = options.probeExecutables && executable.found
      ? probeHost(definition.name, executable.path)
      : undefined;
    const baseStatus = statusFor(executable.found, skillInstalled, runtimeInstalled, commandInstalled);
    const status = probe && !probe.ok && !probe.skipped && baseStatus === "ready" ? "partial" : baseStatus;
    return {
      name: definition.name,
      label: definition.label,
      executable: definition.executable,
      executable_found: executable.found,
      executable_path: executable.path,
      executable_probe: probe,
      skill_dir: definition.skill_dir,
      skill_installed: skillInstalled,
      runtime_file: runtimeFile,
      runtime_installed: runtimeInstalled,
      command_file: definition.command_file,
      command_installed: commandInstalled,
      invocation: definition.invocation,
      status,
      fix_hint: probe && !probe.ok && !probe.skipped
        ? `Host executable was found but --version failed: ${probe.output}`
        : fixHint(definition.name, status, runtimeInstalled)
    };
  });
  return {
    generated_at: new Date().toISOString(),
    home_dir: homeDir,
    hosts,
    summary: {
      ready: hosts.filter((host) => host.status === "ready").length,
      partial: hosts.filter((host) => host.status === "partial").length,
      missing: hosts.filter((host) => host.status === "missing").length
    },
    recommended_user_commands: USER_COMMANDS,
    repair_command: "nms hosts --write-commands"
  };
}

function slashCommandTemplate(host: "claude" | "opencode", skillPath: string, runtimePath: string): string {
  const normalizedSkillPath = skillPath.replaceAll("\\", "/");
  const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");
  const tools = host === "opencode"
    ? "tools:\n  read: true\n  bash: true\n"
    : "triggers:\n  - nms\n  - /nms\n  - no-more-skill\n";
  return `---
description: NMS behavior cockpit and zero-parameter command router
${tools}---

# NMS

Load the installed NMS skill at \`${normalizedSkillPath}\`.

When the user invokes \`/nms\` without extra detail, do not ask for a subcommand. Show the NMS 30-second onboarding path and the current real-data state.

Human-facing entries:

- \`/nms\`: onboarding and current state
- \`/nms-flow\`: behavior cockpit, skill frequency, workflow confidence
- \`/nms-report\`: real-data HTML report
- \`/nms-auto\`: hidden Agent workflow with dry-run gate
- \`/nms-birthday\`: living birthday memory capsule
- \`/nms-birthday-wish\`: grounded future wish contract

Internal commands such as context, brief, suggest, guard, night, doctor, data, and profile stay behind \`/nms-auto\` or diagnostics. Do not expose them as the normal user path.

If local shell execution is available, route through the installed runtime:

- \`node "${normalizedRuntimePath}" /nms\`
- \`node "${normalizedRuntimePath}" /nms-flow\`
- \`node "${normalizedRuntimePath}" /nms-report\`
- \`node "${normalizedRuntimePath}" /nms-auto\`
- \`node "${normalizedRuntimePath}" /nms-birthday\`
- \`node "${normalizedRuntimePath}" /nms-birthday-wish\`

Use only real \`.nms\` data. If no sessions exist, explain that NMS is still learning; never invent skill frequency, workflow history, reports, or personality claims.
`;
}

export function writeHostCommandFiles(options: WriteHostOptions = {}): Array<{ host: "claude" | "opencode"; path: string }> {
  const homeDir = options.homeDir ?? os.homedir();
  const defs = hostDefinitions(homeDir);
  const claude = defs.find((item) => item.name === "claude")!;
  const opencode = defs.find((item) => item.name === "opencode")!;
  const writes = [
    {
      host: "claude" as const,
      path: claude.command_file!,
      skillPath: path.join(claude.skill_dir, "SKILL.md"),
      runtimePath: path.join(claude.skill_dir, "dist", "skill-cli.js")
    },
    {
      host: "opencode" as const,
      path: opencode.command_file!,
      skillPath: path.join(opencode.skill_dir, "SKILL.md"),
      runtimePath: path.join(opencode.skill_dir, "dist", "skill-cli.js")
    }
  ];
  for (const item of writes) {
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.writeFileSync(item.path, slashCommandTemplate(item.host, item.skillPath, item.runtimePath), "utf8");
  }
  return writes.map(({ host, path: outPath }) => ({ host, path: outPath }));
}

export function formatHostReport(report: HostIntegrationReport): string {
  return [
    "== NMS Host Integration ==",
    `home=${report.home_dir}`,
    `summary=ready:${report.summary.ready}, partial:${report.summary.partial}, missing:${report.summary.missing}`,
    "",
    ...report.hosts.flatMap((host) => [
      `[${host.status.toUpperCase()}] ${host.label}`,
      `cli=${host.executable_found ? host.executable_path ?? "found" : "missing"}`,
      `skill=${host.skill_installed ? host.skill_dir : "missing"}`,
      `runtime=${host.runtime_installed ? host.runtime_file : "missing"}`,
      host.command_file ? `command=${host.command_installed ? host.command_file : "missing"}` : "command=(not required)",
      `invoke=${host.invocation.join(" | ")}`,
      host.executable_probe
        ? `probe=${
            host.executable_probe.skipped
              ? "skip"
              : host.executable_probe.ok
                ? "ok"
                : "warn"
          }: ${host.executable_probe.output}`
        : undefined,
      `fix=${host.fix_hint}`,
      ""
    ].filter((line): line is string => Boolean(line))),
    `repair=${report.repair_command}`,
    "restart=Restart Claude Code/OpenCode after writing command files so slash commands are re-indexed."
  ].join("\n");
}
