import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../config.js";
import type {
  ExecutorOutput,
  FailureModel,
  NightReport,
  PolicyLogEntry,
  PlannerOutput,
  ReviewerOutput,
  State,
  StateLogEntry,
  TesterOutput
} from "../types.js";
import { State as S } from "../types.js";
import { validateWriteScope } from "./guards.js";

function makeFailure(
  code: FailureModel["code"],
  reason: string,
  hint: string,
  retry: number,
  nonRetryable: boolean,
  state: State,
  artifact: string
): FailureModel {
  return {
    code,
    failure_reason: reason,
    recovery_hint: hint,
    retry_count: retry,
    non_retryable: nonRetryable,
    state_at_failure: state,
    artifacts_ref: artifact
  };
}

function shellSafeJoinPaths(files: string[]): string {
  return files.map((f) => `"${f.replaceAll('"', '\\"')}"`).join(" ");
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function plannerFromInput(input?: PlannerOutput): PlannerOutput {
  if (!input) {
    throw new Error("Missing planner input. Provide --task-file for night run.");
  }
  if (!input.task?.trim()) throw new Error("Planner input invalid: task is required.");
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("Planner input invalid: files[] is required.");
  }
  return input;
}

function executor(plan: PlannerOutput, cwd: string): ExecutorOutput {
  const paths = shellSafeJoinPaths(plan.files);
  let diff = "";
  try {
    diff = execSync(`git diff -- ${paths}`, { cwd, stdio: "pipe" }).toString();
  } catch {
    diff = "";
  }
  return {
    diff,
    files_modified: plan.files
  };
}

function tester(plan: PlannerOutput, cwd: string): TesterOutput {
  if (plan.test_plan.length === 0) {
    return { passed: false, errors: ["Test phase cannot be skipped: test_plan must include at least one command."] };
  }
  const errors: string[] = [];
  for (const command of plan.test_plan) {
    try {
      execSync(command, { cwd, stdio: "pipe" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Test command failed: ${command}; ${message}`);
    }
  }
  return { passed: errors.length === 0, errors };
}

function review(plan: PlannerOutput, execOut: ExecutorOutput): ReviewerOutput {
  const issues: string[] = [];
  const specApproved = plan.constraints.length > 0;
  if (!specApproved) issues.push("No constraints provided in planner input.");
  const codeApproved = execOut.files_modified.length > 0;
  if (!codeApproved) issues.push("No target files detected.");
  return {
    spec_approved: specApproved,
    code_approved: codeApproved,
    issues
  };
}

function gate(test: TesterOutput, reviewResult: ReviewerOutput): State {
  if (!test.passed) return S.ROLLBACK;
  if (!reviewResult.spec_approved || !reviewResult.code_approved) return S.ROLLBACK;
  return S.COMMIT;
}

function gitBranchName() {
  return `night/dev-${new Date().toISOString().slice(0, 10)}`;
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function currentBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}

function commitTask(message: string, files: string[], cwd: string): void {
  const branch = gitBranchName();
  const safeBranch = branch.replaceAll("/", "-");
  const worktree = path.join(os.tmpdir(), `nms-${safeBranch}-${Date.now()}`);
  execSync(`git worktree add -B ${branch} ${shellQuote(worktree)} HEAD`, { cwd, stdio: "pipe" });
  try {
    for (const file of files) {
      const source = path.resolve(cwd, file);
      if (!fs.existsSync(source) || fs.statSync(source).isDirectory()) continue;
      const target = path.resolve(worktree, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    const paths = shellSafeJoinPaths(files);
    execSync(`git add -- ${paths}`, { cwd: worktree, stdio: "pipe" });
    try {
      execSync("git diff --cached --quiet", { cwd: worktree, stdio: "pipe" });
      throw new Error("No changes to commit in isolated worktree.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("No changes to commit")) throw error;
    }
    execSync(`git commit -m "night: ${message.slice(0, 80)}"`, { cwd: worktree, stdio: "pipe" });
  } finally {
    try {
      execSync(`git worktree remove --force ${shellQuote(worktree)}`, { cwd, stdio: "pipe" });
    } catch {
      // Worktree cleanup failure should not trigger destructive cleanup.
    }
  }
}

function rollback(_cwd: string): void {
  // Production safety: this harness must never reset the user's working tree.
  // Real apply work should happen in an isolated worktree or via scoped patches.
}

export interface NightOptions {
  dryRun: boolean;
  apply: boolean;
  timeBudgetMinutes: number;
  explain?: boolean;
  plannerInput?: PlannerOutput;
  cwd?: string;
}

export function runNightHarness(opts: NightOptions): NightReport {
  const cwd = opts.cwd ?? process.cwd();
  const logs: string[] = [];
  const stateLogs: StateLogEntry[] = [];
  const policyLogs: PolicyLogEntry[] = [];
  const explainChain: string[] = [];
  let retries = 0;
  const started = Date.now();
  const maxMs = Math.max(1, opts.timeBudgetMinutes) * 60 * 1000;

  try {
    plannerFromInput(opts.plannerInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      dry_run: !opts.apply,
      final_state: S.ROLLBACK,
      retries,
      logs: [message],
      policy_logs: policyLogs,
      state_logs: stateLogs,
      explain_chain: opts.explain ? explainChain : undefined,
      failure: makeFailure("CONFIG_ERROR", message, "Provide a valid --task-file JSON.", 0, true, S.PLAN, "task-file")
    };
  }
  const plannerInput = plannerFromInput(opts.plannerInput);

  if (!opts.apply) logs.push("Apply mode disabled. Running in safe mode.");
  if (opts.apply && opts.dryRun) {
    return {
      dry_run: true,
      final_state: S.ROLLBACK,
      retries,
      logs: [...logs, "Cannot use --apply with --dry-run at the same time."],
      policy_logs: policyLogs,
      state_logs: stateLogs,
      explain_chain: opts.explain ? explainChain : undefined,
      failure: makeFailure("CONFIG_ERROR", "Conflicting flags", "Use either --dry-run or --apply", 0, true, S.PLAN, "flags")
    };
  }
  if (opts.apply && !isGitRepo(cwd)) {
    policyLogs.push({ name: "git_repository_guard", status: "block", reason: "not a git repository" });
    return {
      dry_run: false,
      final_state: S.ROLLBACK,
      retries,
      logs: [...logs, "Current directory is not a git repository."],
      policy_logs: policyLogs,
      state_logs: stateLogs,
      explain_chain: opts.explain ? explainChain : undefined,
      failure: makeFailure("CONFIG_ERROR", "Not a git repository", "Initialize git repository first.", 0, true, S.PLAN, cwd)
    };
  }

  while (Date.now() - started < maxMs) {
    let state: State = S.PLAN;
    let t0 = Date.now();
    logs.push(`State=${state}`);
    const plan = plannerInput;
    stateLogs.push({
      state,
      input_summary: plan.task,
      decision: "plan-loaded",
      duration_ms: Date.now() - t0,
      artifacts_ref: "task-file"
    });

    state = S.EXECUTE;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const execOut = executor(plan, cwd);
    const guard = validateWriteScope(execOut.files_modified, DEFAULT_CONFIG);
    policyLogs.push({
      name: "write_scope_guard",
      status: guard.ok ? "pass" : "block",
      reason: guard.reason ?? "all files inside allowed roots and file types"
    });
    stateLogs.push({
      state,
      input_summary: `${execOut.files_modified.length} files`,
      decision: guard.ok ? "policy-pass" : "policy-block",
      duration_ms: Date.now() - t0,
      artifacts_ref: execOut.files_modified.join(",")
    });
    if (!guard.ok) {
      explainChain.push("Execution blocked by write scope policy.");
      return {
        dry_run: !opts.apply,
        final_state: S.ROLLBACK,
        retries,
        logs,
        policy_logs: policyLogs,
        state_logs: stateLogs,
        explain_chain: opts.explain ? explainChain : undefined,
        failure: makeFailure(
          "POLICY_BLOCK",
          guard.reason ?? "Write guard denied",
          "Limit paths to policy-allowed files.",
          retries,
          true,
          S.EXECUTE,
          execOut.files_modified.join(",")
        )
      };
    }

    state = S.TEST;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const testOut = tester(plan, cwd);
    stateLogs.push({
      state,
      input_summary: `${plan.test_plan.length} test commands`,
      decision: testOut.passed ? "passed" : "failed",
      duration_ms: Date.now() - t0,
      artifacts_ref: testOut.errors.join(";")
    });

    state = S.REVIEW;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const reviewOut = review(plan, execOut);
    stateLogs.push({
      state,
      input_summary: "constraints + target files",
      decision: reviewOut.spec_approved && reviewOut.code_approved ? "approved" : "rejected",
      duration_ms: Date.now() - t0,
      artifacts_ref: reviewOut.issues.join(";")
    });

    state = S.GATE;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const decision = gate(testOut, reviewOut);
    logs.push(`Gate=${decision}`);
    stateLogs.push({
      state,
      input_summary: `test=${testOut.passed}, spec=${reviewOut.spec_approved}, code=${reviewOut.code_approved}`,
      decision,
      duration_ms: Date.now() - t0,
      artifacts_ref: "gate"
    });
    explainChain.push(
      `Gate=${decision} because test=${testOut.passed}, spec=${reviewOut.spec_approved}, code=${reviewOut.code_approved}.`
    );

    if (decision === S.COMMIT) {
      if (!opts.apply) {
        logs.push("Dry-run completed. No repository write performed.");
        return {
          dry_run: true,
          final_state: S.GATE,
          retries,
          logs,
          policy_logs: policyLogs,
          state_logs: stateLogs,
          explain_chain: opts.explain ? explainChain : undefined
        };
      }
      if (currentBranch(cwd) === "main") {
        policyLogs.push({ name: "main_branch_guard", status: "block", reason: "main branch commit forbidden" });
        return {
          dry_run: false,
          final_state: S.ROLLBACK,
          retries,
          logs: [...logs, "Apply blocked on main branch."],
          policy_logs: policyLogs,
          state_logs: stateLogs,
          explain_chain: opts.explain ? explainChain : undefined,
          failure: makeFailure(
            "POLICY_BLOCK",
            "Main branch commit forbidden",
            "Switch branch or let harness create night/dev-* branch.",
            retries,
            true,
            S.COMMIT,
            "branch-check"
          )
        };
      }
      policyLogs.push({ name: "isolated_worktree_guard", status: "pass", reason: "apply commit runs in a temporary git worktree" });
      commitTask(plan.task, plan.files, cwd);
      policyLogs.push({ name: "commit_guard", status: "pass", reason: "tests and reviews passed" });
      return {
        dry_run: false,
        final_state: S.COMMIT,
        retries,
        logs,
        policy_logs: policyLogs,
        state_logs: stateLogs,
        explain_chain: opts.explain ? explainChain : undefined
      };
    }

    rollback(cwd);
    retries += 1;
    if (retries >= DEFAULT_CONFIG.harness.max_retry) {
      return {
        dry_run: !opts.apply,
        final_state: S.ROLLBACK,
        retries,
        logs,
        policy_logs: policyLogs,
        state_logs: stateLogs,
        explain_chain: opts.explain ? explainChain : undefined,
        failure: makeFailure(
          testOut.passed ? "REVIEW_FAIL" : "TEST_FAIL",
          "Exceeded max retry",
          "Fix test/review issues and retry.",
          retries,
          true,
          S.ROLLBACK,
          "night-loop"
        )
      };
    }
  }

  return {
    dry_run: !opts.apply,
    final_state: S.ROLLBACK,
    retries,
    logs,
    policy_logs: policyLogs,
    state_logs: stateLogs,
    explain_chain: opts.explain ? explainChain : undefined,
    failure: makeFailure(
      "TIMEOUT",
      "Time budget exceeded",
      "Increase --time-budget or reduce task scope.",
      retries,
      false,
      S.PLAN,
      "time-budget"
    )
  };
}

export function readPlannerInput(taskFile: string): PlannerOutput {
  const raw = fs.readFileSync(taskFile, "utf8");
  return JSON.parse(raw) as PlannerOutput;
}
