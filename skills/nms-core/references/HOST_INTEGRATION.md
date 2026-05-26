# NMS Host Integration

NMS supports three host families:

- Claude Code: skill files plus optional `~/.claude/commands/nms.md`.
- Codex: skill discovery plus `$nms-*` aliases; no slash command file is required.
- OpenCode: skill files plus optional `~/.config/opencode/command/nms.md`.

## User-facing commands

Promote only these commands:

- `/nms`
- `/nms-flow`
- `/nms-report`
- `/nms-auto`
- `/nms-birthday`

Do not promote internal routes such as context, brief, suggest, guard, night, data, profile, or doctor. They are part of `/nms-auto` or diagnostics.

## Repair flow

If `/nms` is not visible in Claude Code or OpenCode:

1. Run `nms hosts`.
2. Optional: run `nms hosts --probe` for a host-aware health check.
3. Run `nms hosts --write-commands`.
4. Restart Claude Code or OpenCode so the command palette is re-indexed.

On Windows, `hosts --probe` executes a real `--version` probe for Claude Code and falls back to installation/runtime validation for packaged Codex/OpenCode hosts.

The generated command files must be zero-parameter first: `/nms` should show onboarding and current state, not ask the user to choose a subcommand.

## Codex behavior

Codex should use skill discovery and aliases:

- `$nms-flow`
- `$nms-report`
- `$nms-auto`
- `$nms-birthday`
- or mention `no-more-skill`

Do not create a Codex slash command file unless the host adds native support for that pattern.
