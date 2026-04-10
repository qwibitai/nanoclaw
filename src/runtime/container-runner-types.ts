import { ChildProcess } from 'child_process';

import { RegisteredGroup } from '../core/types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  compiledSystemPrompt?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface RunContainerAgentOptions {
  timeoutMs?: number;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface HostRuntimeContext {
  groupDir: string;
  globalDir?: string;
  groupSessionRoot: string;
  groupSessionsDir: string;
  groupIpcDir: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface TaskSnapshotRow {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

export interface RunnerProcessSpec {
  group: RegisteredGroup;
  input: ContainerInput;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  onProcess: (proc: ChildProcess, containerName: string) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  options?: RunContainerAgentOptions;
  runtime: 'host' | 'container';
  runnerLabel: string;
  processName: string;
  startTime: number;
  logsDir: string;
  runtimeDetails: string[];
  mounts: VolumeMount[];
}
