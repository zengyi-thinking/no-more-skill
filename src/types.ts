export type ToolName = "claude" | "codex" | "opencode";
export type SourceToolName = ToolName | "opencode" | "unknown";

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
  domain?: string;
  domain_confidence?: number;
}

export interface DomainPack {
  domain: string;
  skills: Record<string, string[]>;
  workflow_templates: string[][];
  style_signals: Array<{
    name: string;
    patterns: string[];
  }>;
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
  domain_counts: Record<string, number>;
  last_updated: string;
  ingest_count: number;
  perf_windows: {
    ingest_ms: number[];
    flow_ms: number[];
    night_ms: number[];
    max_window: number;
  };
  quality_metrics: {
    behavior_score: number;
    workflow_confidence: number;
    session_velocity_7d: number;
    stale_risk: number;
    streak_days: number;
  };
}

export interface Database {
  schema_version: number;
  sessions: SessionRecord[];
  stats: Stats;
  user_profile: UserProfile;
}

export interface NmsEvent {
  event_id: string;
  type: "CONTEXT_COMPRESSED" | "PROFILE_PATCH" | "REPORT_GENERATED" | "NIGHT_RUN";
  created_at: string;
  project_id: string;
  source_tool: SourceToolName;
  input_hash: string;
  redaction_level: "safe" | "private" | "raw";
  payload_ref: string;
}

export interface SessionV3 {
  id: string;
  created_at: string;
  project_id: string;
  domain: string;
  domain_confidence?: number;
  source_tool: SourceToolName;
  compressed_text_ref?: string;
  conversation_ref?: string;
  skills: Array<{
    name: string;
    category: string;
    confidence: number;
    evidence: string[];
  }>;
  workflow: {
    steps: string[];
    edges: Array<{ from: string; to: string }>;
    confidence: number;
  };
  user_style_observations: Array<{
    claim: string;
    confidence: number;
    evidence: string[];
  }>;
}

export interface ProfilePatch {
  id: string;
  created_at: string;
  claim: string;
  dimension: "style" | "preference" | "workflow" | "avoidance" | "domain";
  confidence: number;
  evidence_refs: string[];
  status: "draft" | "approved" | "rejected";
}

export interface ArtifactRecord {
  artifact_id: string;
  type: "report" | "image" | "prompt" | "night-run" | "context";
  created_at: string;
  path: string;
  source_data_hash: string;
  real_data_only: boolean;
  metadata: Record<string, unknown>;
}

export interface BirthdayMemory {
  latest_capsule_ref: string;
  generated_at: string;
  north_star: string;
  retained_commitments: string[];
  next_year_targets: string[];
  risks_to_watch: string[];
}

export interface BirthdayCapsule {
  schema_version: 1;
  generated_at: string;
  project_id: string;
  period_days: number;
  sample_count: number;
  previous_sample_count: number;
  north_star: string;
  retained_commitments: string[];
  stable_workflows: string[];
  emerging_skills: string[];
  changed_habits: string[];
  growth_vectors: Array<{
    name: string;
    signal: string;
    evidence: string[];
  }>;
  risks_to_watch: string[];
  next_year_targets: string[];
  agent_instructions: string[];
  artifacts: {
    capsule_ref: string;
    html_report_ref: string;
    markdown_ref: string;
    poster_ref?: string;
  };
}

export interface AgentContext {
  schema_version: number;
  generated_at: string;
  project_id: string;
  task_summary: string;
  user_style: {
    communication: string[];
    workflow: string[];
    avoid: string[];
  };
  relevant_workflows: Array<{
    name: string;
    steps: string[];
    confidence: number;
    evidence_refs: string[];
  }>;
  relevant_domains: Array<{
    name: string;
    count: number;
    confidence: number;
  }>;
  recommended_agent_behavior: string[];
  safety_policy: {
    default_apply: boolean;
    requires_explicit_apply: boolean;
    allowed_write_roots: string[];
    blocked_patterns: string[];
  };
  data_quality: {
    sample_count: number;
    confidence: number;
    warnings: string[];
  };
  birthday_memory?: BirthdayMemory;
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
  code: "CONFIG_ERROR" | "POLICY_BLOCK" | "TEST_FAIL" | "REVIEW_FAIL" | "TIMEOUT";
  failure_reason: string;
  recovery_hint: string;
  retry_count: number;
  non_retryable: boolean;
  state_at_failure: State;
  artifacts_ref: string;
}

export interface StateLogEntry {
  state: State;
  input_summary: string;
  decision: string;
  duration_ms: number;
  artifacts_ref: string;
}

export interface PolicyLogEntry {
  name: string;
  status: "pass" | "warn" | "block";
  reason: string;
}

export interface NightReport {
  dry_run: boolean;
  final_state: State;
  retries: number;
  logs: string[];
  policy_logs?: PolicyLogEntry[];
  state_logs?: StateLogEntry[];
  explain_chain?: string[];
  failure?: FailureModel;
}
