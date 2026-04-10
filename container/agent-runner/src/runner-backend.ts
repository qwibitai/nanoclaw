/**
 * Provider-agnostic runner backend interface.
 * Allows swapping Claude CLI for other providers (Codex, etc.) via env var.
 */

export interface RunOptions {
  sessionId?: string;
  cwd: string;
  mcpConfigPath?: string;
  appendSystemPrompt?: string;
  additionalDirs?: string[];
  env: Record<string, string | undefined>;
  model?: string;
}

export interface RunResult {
  output: string | null;
  newSessionId?: string;
  exitCode: number;
  usage?: { inputTokens: number; contextWindow: number };
}

export interface RunnerBackend {
  invoke(prompt: string, options: RunOptions): Promise<RunResult>;
  supportsResume: boolean;
}
