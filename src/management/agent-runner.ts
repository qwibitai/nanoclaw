// src/management/agent-runner.ts

export interface SpawnOptions {
  sessionKey: string;
  model: string;
  systemPrompt: string;
  initialPrompt?: string;
  resumeSessionId?: string;
}

export interface AgentSession {
  sessionKey: string;
  startedAt: Date;
}

export type RunnerEventMap = {
  output: (sessionKey: string, data: string) => void;
  stderr: (sessionKey: string, data: string) => void;
  exit: (sessionKey: string, code: number | null) => void;
};

export interface AgentRunner {
  spawn(opts: SpawnOptions): Promise<AgentSession>;
  sendMessage(sessionKey: string, message: string): Promise<void>;
  kill(sessionKey: string): Promise<void>;
  killAll(): Promise<void>;
  get activeCount(): number;
  getSession(sessionKey: string): AgentSession | undefined;

  on<K extends keyof RunnerEventMap>(
    event: K,
    listener: RunnerEventMap[K],
  ): void;
}
