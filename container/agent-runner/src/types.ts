export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  personalMode?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AgentTurnResult {
  newSessionId?: string;
  lastAssistantCursor?: string;
  closedDuringQuery: boolean;
}

export interface AgentTurnContext {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  mcpServerPath: string;
  containerInput: ContainerInput;
  agentEnv: Record<string, string | undefined>;
  emitOutput: (output: ContainerOutput) => void;
  log: (message: string) => void;
  drainIpcInput: () => string[];
  shouldClose: () => boolean;
  waitForIpcMessage: () => Promise<string | null>;
}

export interface AgentProvider {
  name: string;
  runTurn(context: AgentTurnContext): Promise<AgentTurnResult>;
}
