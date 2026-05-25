# NMS Safety Rules

NMS automates behavior-aware execution. Safety defaults must remain strict.

## Hard Boundaries

- Default mode is dry-run.
- `--apply` must be explicit.
- `main` branch commits are forbidden.
- Out-of-policy paths are blocked before execution.
- Tests and review cannot be skipped.
- Rollback must be non-destructive.
- Secrets must not be written into reports, artifacts, or sessions.

## Allowed Write Scope

Default allowed roots:

- `sandbox/`
- `feature/`

Core paths require explicit whitelist and must still pass file-type policy.

Allowed file kinds:

- UI files.
- New files.
- Test files.

## Rollback Policy

Never use full working-tree reset. Avoid:

```bash
git reset --hard
git checkout -- .
```

Prefer:

- Isolated worktree.
- Scoped patch capture.
- Explicit file-level restore only for files created by the current run.

## Policy Logs

Night runs should emit `policy_logs` with:

- Check name.
- `pass`, `warn`, or `block`.
- Reason.

These logs are part of the user trust surface.
