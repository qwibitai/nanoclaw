export interface ProviderCapabilities {
  persistentSessions: boolean;
  projectMemory: boolean;
  remoteControl: boolean;
  agentTeams: boolean;
  providerSkills: boolean;
}

export interface ProviderCheckResult {
  status: 'ok' | 'warning' | 'error';
  message: string;
  code?: string;
}

export interface ProviderFileMaterialization {
  sourcePath?: string;
  targetPath: string;
  content?: string;
  onlyIfMissing?: boolean;
}

export interface ProviderDirectorySync {
  sourcePath: string;
  targetPath: string;
}

export interface PrepareSessionContext {
  projectRoot: string;
  dataDir: string;
  groupFolder: string;
  groupDir: string;
  isMain: boolean;
  sessionId?: string;
}

export interface PreparedSession {
  providerStateDir: string;
  files: ProviderFileMaterialization[];
  directorySyncs?: ProviderDirectorySync[];
  fallbackProviderStateDirs?: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface BuildContainerSpecContext {
  projectRoot: string;
  dataDir: string;
  groupFolder: string;
  isMain: boolean;
  preparedSession: PreparedSession;
}

export interface ProviderContainerSpec {
  mounts: ProviderMount[];
  env: Record<string, string>;
  workdir?: string;
}

export interface RuntimeInvocationContext {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  providerOptions?: Record<string, unknown>;
}

export interface ProviderRuntimeInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  providerData?: Record<string, unknown>;
}

export interface RemoteControlContext {
  groupFolder: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface RemoteControlResult {
  status: 'started' | 'unsupported';
  url?: string;
  message?: string;
}

export interface AgentProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  validateHost(
    env: NodeJS.ProcessEnv,
    projectRoot: string,
  ): ProviderCheckResult[];
  prepareSession(ctx: PrepareSessionContext): PreparedSession;
  buildContainerSpec(ctx: BuildContainerSpecContext): ProviderContainerSpec;
  serializeRuntimeInput(ctx: RuntimeInvocationContext): ProviderRuntimeInput;
  startRemoteControl?(ctx: RemoteControlContext): Promise<RemoteControlResult>;
  stopRemoteControl?(): Promise<void>;
}
