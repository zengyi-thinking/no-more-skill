import { execSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../config.js";
import type {
  ExecutorOutput,
  FailureModel,
  NightReport,
  PlannerOutput,
  ReviewerOutput,
  State,
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
  cwd?: string;
}

export function runNightHarness(opts: NightOptions): NightReport {
  const cwd = opts.cwd ?? process.cwd();
  const logs: string[] = [];
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
      failure: {
        failure_reason: "Conflicting flags",
        recovery_hint: "Use either --dry-run or --apply",
        retry_count: 0,
        non_retryable: true,
        state_at_failure: S.PLAN,
        artifacts_ref: "flags"
      }
    };
  }

  if (opts.apply && !isGitRepo(cwd)) {
    return {
      dry_run: false,
      final_state: S.ROLLBACK,
      retries,
      logs: [...logs, "Apply blocked: current directory is not a git repository."],
      failure: {
        failure_reason: "Not a git repository",
        recovery_hint: "Initialize git repo before --apply",
        retry_count: 0,
        non_retryable: true,
        state_at_failure: S.PLAN,
        artifacts_ref: cwd
      }
    };
  }

  while (Date.now() - started < maxMs) {
    let state: State = S.PLAN;
    logs.push(`State=${state}`);
    const plan = planner();

    state = S.EXECUTE;
    logs.push(`State=${state}`);
    const exec = executor(plan);
    const guard = validateWriteScope(exec.files_modified, DEFAULT_CONFIG);
    if (!guard.ok) {
      const failure: FailureModel = {
        failure_reason: guard.reason ?? "Write guard denied",
        recovery_hint: "Limit files to sandbox/feature UI/new/test paths",
        retry_count: retries,
        non_retryable: true,
        state_at_failure: S.EXECUTE,
        artifacts_ref: exec.diff
      };
      return { dry_run: !opts.apply, final_state: S.ROLLBACK, retries, logs, failure };
    }

    state = S.TEST;
    logs.push(`State=${state}`);
    const test = tester(exec);

    state = S.REVIEW;
    logs.push(`State=${state}`);
    const reviewResult = review(plan, exec);

    state = S.GATE;
    logs.push(`State=${state}`);
    const decision = gate(test, reviewResult);
    logs.push(`Gate=${decision}`);

    if (decision === S.COMMIT) {
      if (!opts.apply) {
        logs.push("Dry-run success. Commit skipped by design.");
        return { dry_run: true, final_state: S.GATE, retries, logs };
      }
      if (currentBranch(cwd) === "main") {
        return {
          dry_run: false,
          final_state: S.ROLLBACK,
          retries,
          logs: [...logs, "Apply blocked on main branch."],
          failure: {
            failure_reason: "Main branch commit forbidden",
            recovery_hint: "Switch to non-main or let harness create night/dev-* branch",
            retry_count: retries,
            non_retryable: true,
            state_at_failure: S.COMMIT,
            artifacts_ref: "git branch check"
          }
        };
      }
      commitTask(exec.diff, cwd);
      return { dry_run: false, final_state: S.COMMIT, retries, logs };
    }

    rollback(cwd);
    retries += 1;
    if (retries >= DEFAULT_CONFIG.harness.max_retry) {
      const failure: FailureModel = {
        failure_reason: "Exceeded max retry",
        recovery_hint: "Review test/reviewer outputs and rerun with fixed plan",
        retry_count: retries,
        non_retryable: true,
        state_at_failure: S.ROLLBACK,
        artifacts_ref: "night.log"
      };
      return { dry_run: !opts.apply, final_state: S.ROLLBACK, retries, logs, failure };
    }
    logs.push("Rollback complete; restarting from PLAN.");
  }

  return {
    dry_run: !opts.apply,
    final_state: S.ROLLBACK,
    retries,
    logs,
    failure: {
      failure_reason: "Time budget exceeded",
      recovery_hint: "Increase --time-budget or simplify tasks",
      retry_count: retries,
      non_retryable: false,
      state_at_failure: S.PLAN,
      artifacts_ref: "time budget"
    }
  };
}
