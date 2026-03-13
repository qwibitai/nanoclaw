// TypeScript types derived from tanren openapi.json components/schemas.

// --- Enums (string literal unions) ---

export type Phase =
  | "do-task"
  | "audit-task"
  | "run-demo"
  | "audit-spec"
  | "investigate"
  | "gate"
  | "setup"
  | "cleanup";

export type Cli = "opencode" | "codex" | "claude" | "bash";

export type DispatchRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type Outcome = "success" | "fail" | "blocked" | "error" | "timeout";

export type VMProvider = "manual" | "hetzner";

export type VMStatus = "active" | "provisioning" | "releasing" | "released";

export type RunEnvironmentStatus =
  | "provisioning"
  | "provisioned"
  | "executing"
  | "tearing_down"
  | "completed"
  | "failed";

// --- Request types ---

export interface DispatchRequest {
  project: string;
  phase: Phase;
  branch: string;
  spec_folder: string;
  cli: Cli;
  model?: string | null;
  timeout?: number;
  environment_profile?: string;
  context?: string | null;
  gate_cmd?: string | null;
}

export interface ProvisionRequest {
  project: string;
  branch: string;
  environment_profile?: string;
}

export interface RunFullRequest {
  project: string;
  branch: string;
  spec_path: string;
  phase: Phase;
  environment_profile?: string;
  timeout?: number;
  context?: string | null;
  gate_cmd?: string | null;
}

export interface EventsQuery {
  workflow_id?: string;
  event_type?: string;
  limit?: number;
  offset?: number;
}

// --- Response types ---

export interface HealthResponse {
  status: string;
  version: string;
  uptime_seconds: number;
}

export interface ReadinessResponse {
  status: string;
}

export interface DispatchAccepted {
  dispatch_id: string;
  status?: string;
}

export interface DispatchDetail {
  workflow_id: string;
  phase: Phase;
  project: string;
  spec_folder: string;
  branch: string;
  cli: Cli;
  model?: string | null;
  timeout: number;
  environment_profile: string;
  context?: string | null;
  gate_cmd?: string | null;
  status: DispatchRunStatus;
  outcome?: Outcome | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface DispatchCancelled {
  dispatch_id: string;
  status?: DispatchRunStatus;
}

export interface VMSummary {
  vm_id: string;
  host: string;
  provider: VMProvider;
  workflow_id?: string | null;
  project?: string | null;
  status: VMStatus;
  created_at: string;
}

export interface VMHandle {
  vm_id: string;
  host: string;
  provider?: VMProvider;
  created_at: string;
  labels?: Record<string, string>;
  hourly_cost?: number | null;
}

export interface VMDryRunResult {
  provider: VMProvider;
  server_type?: string | null;
  estimated_cost_hourly?: number | null;
  would_provision: boolean;
  requirements: VMRequirements;
}

export interface VMRequirements {
  profile: string;
  cpu?: number;
  memory_gb?: number;
  gpu?: boolean;
  server_type?: string | null;
  labels?: Record<string, string>;
}

export interface VMReleaseConfirmed {
  vm_id: string;
  status?: VMStatus;
}

export interface RunEnvironment {
  env_id: string;
  vm_id: string;
  host: string;
  status?: RunEnvironmentStatus;
}

export interface RunExecuteAccepted {
  env_id: string;
  dispatch_id: string;
  status?: RunEnvironmentStatus;
}

export interface RunTeardownAccepted {
  env_id: string;
  status?: RunEnvironmentStatus;
}

export interface RunStatus {
  env_id: string;
  status: RunEnvironmentStatus;
  phase?: Phase | null;
  outcome?: Outcome | null;
  started_at?: string | null;
  duration_secs?: number | null;
}

export interface ConfigResponse {
  ipc_dir: string;
  github_dir: string;
  poll_interval: number;
  heartbeat_interval: number;
  max_opencode: number;
  max_codex: number;
  max_gate: number;
  events_enabled: boolean;
  remote_enabled: boolean;
}

export interface PaginatedEvents {
  events?: TanrenEvent[];
  total: number;
  limit: number;
  offset: number;
}

// --- Event types ---

export interface DispatchReceivedEvent {
  timestamp: string;
  workflow_id: string;
  type: "dispatch_received";
  phase: string;
  project: string;
  cli: string;
}

export interface PhaseStartedEvent {
  timestamp: string;
  workflow_id: string;
  type: "phase_started";
  phase: string;
  worktree_path: string;
}

export interface PhaseCompletedEvent {
  timestamp: string;
  workflow_id: string;
  type: "phase_completed";
  phase: string;
  outcome: string;
  signal?: string | null;
  duration_secs: number;
  exit_code: number;
}

export interface PreflightCompletedEvent {
  timestamp: string;
  workflow_id: string;
  type: "preflight_completed";
  passed: boolean;
  repairs?: string[];
}

export interface IntegrityRepairs {
  branch_switched?: boolean;
  spec_reverted?: boolean;
  plan_reverted?: boolean;
  makefile_modified?: boolean;
  deps_modified?: boolean;
  gitignore_modified?: boolean;
  wip_committed?: boolean;
}

export interface PostflightCompletedEvent {
  timestamp: string;
  workflow_id: string;
  type: "postflight_completed";
  phase: string;
  pushed?: boolean | null;
  integrity_repairs?: IntegrityRepairs;
}

export interface ErrorOccurredEvent {
  timestamp: string;
  workflow_id: string;
  type: "error_occurred";
  phase: string;
  error: string;
  error_class?: string | null;
}

export interface RetryScheduledEvent {
  timestamp: string;
  workflow_id: string;
  type: "retry_scheduled";
  phase: string;
  attempt: number;
  max_attempts: number;
  backoff_secs: number;
}

export interface VMProvisionedEvent {
  timestamp: string;
  workflow_id: string;
  type: "vm_provisioned";
  vm_id: string;
  host: string;
  provider: VMProvider;
  project: string;
  profile: string;
  hourly_cost?: number | null;
}

export interface VMReleasedEvent {
  timestamp: string;
  workflow_id: string;
  type: "vm_released";
  vm_id: string;
  duration_secs: number;
  estimated_cost?: number | null;
}

export interface BootstrapCompletedEvent {
  timestamp: string;
  workflow_id: string;
  type: "bootstrap_completed";
  vm_id: string;
  installed?: string[];
  skipped?: string[];
  duration_secs?: number;
}

export type TanrenEvent =
  | DispatchReceivedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | PreflightCompletedEvent
  | PostflightCompletedEvent
  | ErrorOccurredEvent
  | RetryScheduledEvent
  | VMProvisionedEvent
  | VMReleasedEvent
  | BootstrapCompletedEvent;

// --- Validation types ---

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}
