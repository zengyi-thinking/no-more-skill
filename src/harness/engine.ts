import { execSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../config.js";
import type {
  ExecutorOutput,
  FailureModel,
  NightReport,
  PlannerOutput,
  ReviewerOutput,
  State,
  StateLogEntry,
  TesterOutput
} from "../types.js";
import { State as S } from "../types.js";
import { validateWriteScope } from "./guards.js";

function planner(task = "Implement planned change safely"): PlannerOutput {
  return {
    task,
    files: ["sandbox/new/ui-demo.tsx", "sandbox/new/ui-demo.test.ts"],
    constraints: ["No main branch commit", "UI/new/tests only", "Must pass test and review"],
    test_plan: ["Run unit tests", "Static review check"]
  };
}

function executor(plan: PlannerOutput): ExecutorOutput {
  return {
    diff: `Simulated diff for task: ${plan.task}`,
    files_modified: plan.files
  };
}

function tester(_exec: ExecutorOutput): TesterOutput {
  return { passed: true, errors: [] };
}

function reviewerSpec(plan: PlannerOutput): { approved: boolean; issues: string[] } {
  if (!plan.task.trim()) return { approved: false, issues: ["Empty task is not allowed"] };
  return { approved: true, issues: [] };
}

function reviewerCode(exec: ExecutorOutput): { approved: boolean; issues: string[] } {
  if (!exec.diff.trim()) return { approved: false, issues: ["Empty diff detected"] };
  return { approved: true, issues: [] };
}

function review(plan: PlannerOutput, exec: ExecutorOutput): ReviewerOutput {
  const spec = reviewerSpec(plan);
  const code = reviewerCode(exec);
  return {
    spec_approved: spec.approved,
    code_approved: code.approved,
    issues: [...spec.issues, ...code.issues]
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

function commitTask(diff: string, cwd: string): void {
  const branch = gitBranchName();
  execSync(`git checkout -B ${branch}`, { cwd, stdio: "pipe" });
  execSync("git add -A", { cwd, stdio: "pipe" });
  execSync(`git commit -m "night: ${diff.slice(0, 60)}"`, { cwd, stdio: "pipe" });
}

function rollback(cwd: string): void {
  try {
    execSync("git reset --hard HEAD", { cwd, stdio: "pipe" });
  } catch {
    // no-op when git is unavailable in demo mode
  }
}

export interface NightOptions {
  dryRun: boolean;
  apply: boolean;
  timeBudgetMinutes: number;
  explain?: boolean;
  cwd?: string;
}

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

export function runNightHarness(opts: NightOptions): NightReport {
  const cwd = opts.cwd ?? process.cwd();
  const logs: string[] = [];
  const stateLogs: StateLogEntry[] = [];
  const explainChain: string[] = [];
  let retries = 0;
  const started = Date.now();
  const maxMs = Math.max(1, opts.timeBudgetMinutes) * 60 * 1000;

  if (!opts.apply) {
    logs.push("Apply mode disabled. Running in safe mode.");
  }

  if (opts.apply && opts.dryRun) {
    return {
      dry_run: true,
      final_state: S.ROLLBACK,
      retries,
      logs: [...logs, "Cannot use --apply with --dry-run at the same time."],
      state_logs: stateLogs,
      explain_chain: opts.explain ? explainChain : undefined,
      failure: makeFailure("CONFIG_ERROR", "Conflicting flags", "Use either --dry-run or --apply", 0, true, S.PLAN, "flags")
    };
  }

  if (opts.apply && !isGitRepo(cwd)) {
    return {
      dry_run: false,
      final_state: S.ROLLBACK,
      retries,
      logs: [...logs, "Apply blocked: current directory is not a git repository."],
      state_logs: stateLogs,
      explain_chain: opts.explain ? explainChain : undefined,
      failure: makeFailure("CONFIG_ERROR", "Not a git repository", "Initialize git repo before --apply", 0, true, S.PLAN, cwd)
    };
  }

  while (Date.now() - started < maxMs) {
    let state: State = S.PLAN;
    let t0 = Date.now();
    logs.push(`State=${state}`);
    const plan = planner();
    stateLogs.push({
      state,
      input_summary: plan.task,
      decision: "plan-created",
      duration_ms: Date.now() - t0,
      artifacts_ref: plan.files.join(",")
    });

    state = S.EXECUTE;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const exec = executor(plan);
    const guard = validateWriteScope(exec.files_modified, DEFAULT_CONFIG);
    stateLogs.push({
      state,
      input_summary: `${exec.files_modified.length} files`,
      decision: guard.ok ? "policy-pass" : "policy-block",
      duration_ms: Date.now() - t0,
      artifacts_ref: exec.files_modified.join(",")
    });
    if (!guard.ok) {
      explainChain.push("Gate aborted because write policy check failed during EXECUTE.");
      const failure = makeFailure(
        "POLICY_BLOCK",
        guard.reason ?? "Write guard denied",
        "Limit files to sandbox/feature UI/new/test paths",
        retries,
        true,
        S.EXECUTE,
        exec.diff
      );
      return { dry_run: !opts.apply, final_state: S.ROLLBACK, retries, logs, state_logs: stateLogs, explain_chain: opts.explain ? explainChain : undefined, failure };
    }

    state = S.TEST;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const test = tester(exec);
    stateLogs.push({
      state,
      input_summary: "unit checks",
      decision: test.passed ? "passed" : "failed",
      duration_ms: Date.now() - t0,
      artifacts_ref: test.errors.join(";")
    });

    state = S.REVIEW;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const reviewResult = review(plan, exec);
    stateLogs.push({
      state,
      input_summary: "spec+code dual reviewer",
      decision: reviewResult.spec_approved && reviewResult.code_approved ? "approved" : "rejected",
      duration_ms: Date.now() - t0,
      artifacts_ref: reviewResult.issues.join(";")
    });

    state = S.GATE;
    t0 = Date.now();
    logs.push(`State=${state}`);
    const decision = gate(test, reviewResult);
    logs.push(`Gate=${decision}`);
    stateLogs.push({
      state,
      input_summary: `test=${test.passed},spec=${reviewResult.spec_approved},code=${reviewResult.code_approved}`,
      decision,
      duration_ms: Date.now() - t0,
      artifacts_ref: "gate"
    });
    explainChain.push(`Gate decision=${decision} because test=${test.passed}, spec=${reviewResult.spec_approved}, code=${reviewResult.code_approved}.`);

    if (decision === S.COMMIT) {
      if (!opts.apply) {
        logs.push("Dry-run success. Commit skipped by design.");
        return { dry_run: true, final_state: S.GATE, retries, logs, state_logs: stateLogs, explain_chain: opts.explain ? explainChain : undefined };
      }
      if (currentBranch(cwd) === "main") {
        explainChain.push("Apply blocked because current branch is main.");
        return {
          dry_run: false,
          final_state: S.ROLLBACK,
          retries,
          logs: [...logs, "Apply blocked on main branch."],
          state_logs: stateLogs,
          explain_chain: opts.explain ? explainChain : undefined,
          failure: makeFailure("POLICY_BLOCK", "Main branch commit forbidden", "Switch to non-main or let harness create night/dev-* branch", retries, true, S.COMMIT, "git branch check")
        };
      }
      commitTask(exec.diff, cwd);
      return { dry_run: false, final_state: S.COMMIT, retries, logs, state_logs: stateLogs, explain_chain: opts.explain ? explainChain : undefined };
    }

    explainChain.push("Gate returned ROLLBACK; rolling back and retrying from PLAN.");
    rollback(cwd);
    retries += 1;
    if (retries >= DEFAULT_CONFIG.harness.max_retry) {
      const failure = makeFailure(
        test.passed ? "REVIEW_FAIL" : "TEST_FAIL",
        "Exceeded max retry",
        "Review test/reviewer outputs and rerun with fixed plan",
        retries,
        true,
        S.ROLLBACK,
        "night.log"
      );
      return { dry_run: !opts.apply, final_state: S.ROLLBACK, retries, logs, state_logs: stateLogs, explain_chain: opts.explain ? explainChain : undefined, failure };
    }
    logs.push("Rollback complete; restarting from PLAN.");
  }

  return {
    dry_run: !opts.apply,
    final_state: S.ROLLBACK,
    retries,
    logs,
    state_logs: stateLogs,
    explain_chain: opts.explain ? explainChain : undefined,
    failure: makeFailure("TIMEOUT", "Time budget exceeded", "Increase --time-budget or simplify tasks", retries, false, S.PLAN, "time budget")
  };
}
