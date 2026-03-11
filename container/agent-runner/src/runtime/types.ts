export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  engine?: 'claude' | 'codex';
  secrets?: Record<string, string>;
}

export interface RuntimeHooks {
  onLog: (message: string) => void;
  onResult: (result: string | null, newSessionId?: string) => void;
}

export interface RuntimeIpc {
  shouldClose: () => boolean;
  drainIpcInput: () => string[];
  ipcPollMs: number;
}

export interface RunQueryInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  containerInput: ContainerInput;
  sdkEnv: Record<string, string | undefined>;
}

export interface RunQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  nextPrompt?: string;
}

export interface AgentRuntime {
  runQuery(input: RunQueryInput): Promise<RunQueryResult>;
}
