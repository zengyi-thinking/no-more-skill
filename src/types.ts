export type ToolName = "claude" | "codex";

export interface HookInput {
  compressed_text: string;
  conversation: string;
  tool: ToolName;
}

export interface HookOutput {
  skills_used: string[];
  workflow: string[];
  edges: Array<{ from: string; to: string }>;
  user_style: string;
}

export interface SessionRecord extends HookInput, HookOutput {
  id: string;
  created_at: string;
}

export interface UserProfile {
  style: string;
  top_skills: string[];
  top_workflows: string[];
  updated_at: string;
}

export interface Stats {
  skill_counts: Record<string, number>;
  workflow_counts: Record<string, number>;
  last_updated: string;
}

export interface Database {
  schema_version: number;
  sessions: SessionRecord[];
  stats: Stats;
  user_profile: UserProfile;
}

export interface NmsConfig {
  cleaner: {
    max_skills: number;
    max_workflows: number;
    decay_days: number;
  };
  harness: {
    max_retry: number;
    allowed_roots: string[];
    core_explicit_whitelist: string[];
  };
}

export enum State {
  PLAN = "PLAN",
  EXECUTE = "EXECUTE",
  TEST = "TEST",
  REVIEW = "REVIEW",
  GATE = "GATE",
  COMMIT = "COMMIT",
  ROLLBACK = "ROLLBACK"
}

export interface PlannerOutput {
  task: string;
  files: string[];
  constraints: string[];
  test_plan: string[];
}

export interface ExecutorOutput {
  diff: string;
  files_modified: string[];
}

export interface TesterOutput {
  passed: boolean;
  errors: string[];
}

export interface ReviewerOutput {
  spec_approved: boolean;
  code_approved: boolean;
  issues: string[];
}

export interface FailureModel {
  failure_reason: string;
  recovery_hint: string;
  retry_count: number;
  non_retryable: boolean;
  state_at_failure: State;
  artifacts_ref: string;
}

export interface NightReport {
  dry_run: boolean;
  final_state: State;
  retries: number;
  logs: string[];
  failure?: FailureModel;
}
