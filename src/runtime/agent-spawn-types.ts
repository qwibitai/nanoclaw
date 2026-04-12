import { ChildProcess } from 'child_process';

import { RegisteredGroup, ThinkingOverride } from '../core/types.js';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledJob?: boolean;
  assistantName?: string;
  script?: string;
  compiledSystemPrompt?: string;
  thinking?: ThinkingOverride;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface RunAgentOptions {
  timeoutMs?: number;
}

export interface HostRuntimeContext {
  groupDir: string;
  globalDir?: string;
  groupIpcDir: string;
  runnerRoot: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface JobSnapshotRow {
  id: string;
  name: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  status: string;
  group_scope: string;
  linked_sessions: string[];
  next_run: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  timeout_ms: number;
  max_retries: number;
  retry_backoff_ms: number;
  max_consecutive_failures: number;
  consecutive_failures: number;
  pause_reason: string | null;
}

export interface JobRunSnapshotRow {
  run_id: string;
  job_id: string;
  scheduled_for: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  result_summary: string | null;
  error_summary: string | null;
  retry_count: number;
  notified_at: string | null;
}

export interface RunnerProcessSpec {
  group: RegisteredGroup;
  input: AgentInput;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  onProcess: (proc: ChildProcess, containerName: string) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  options?: RunAgentOptions;
  runnerLabel: string;
  processName: string;
  startTime: number;
  logsDir: string;
  runtimeDetails: string[];
}
