export interface ProviderCapabilities {
  persistentSessions: boolean;
  projectMemory: boolean;
  remoteControl: boolean;
  agentTeams: boolean;
  providerSkills: boolean;
}

export interface ProviderRuntimeInput {
  providerId: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface PrepareWorkspaceContext {
  providerHomeDir: string;
  workspaceDir: string;
  globalMemoryDir?: string;
  sessionId?: string;
}

export interface PreparedWorkspace {
  memoryFiles: Array<{
    sourcePath: string;
    targetPath: string;
    content?: string;
  }>;
  providerState?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'provider_state'; state: Record<string, unknown> };

export interface ContainerProviderContext {
  input: ProviderRuntimeInput;
  abortSignal: AbortSignal;
}

export interface ContainerAgentProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  prepareWorkspace(
    ctx: PrepareWorkspaceContext,
  ): PreparedWorkspace | Promise<PreparedWorkspace>;
  run(
    ctx: ContainerProviderContext,
  ): AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;
}
