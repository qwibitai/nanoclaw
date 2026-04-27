/**
 * Type definitions for nanoclaw-codex-provider
 */

// ---------------------------------------------------------------------------
// NanoClaw Provider Plugin Interface
// ---------------------------------------------------------------------------

/**
 * Provider plugins implement this interface to integrate alternative LLM backends.
 * The host module (host.ts) exports a default ProviderPlugin instance.
 * The container module (provider-codex.ts) is copied into the agent container at runtime.
 */
export interface ProviderPlugin {
  /** Provider name identifier, e.g. 'codex' */
  name: string;

  /** Get provider-specific secrets to pass to container via stdin */
  getSecrets(): Promise<Record<string, string>>;

  /** Check if this provider is ready (authenticated) */
  isAuthenticated(): boolean;

  /** Interactive auth/setup flow */
  setup(): Promise<void>;

  /** Container-side provider module filename (relative to plugin dir) */
  containerProvider: string;
}

// ---------------------------------------------------------------------------
// Container Types (used by provider-codex.ts)
// ---------------------------------------------------------------------------

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  provider?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Codex API Types
// ---------------------------------------------------------------------------

export type CodexInputItem =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface CodexOutputItem {
  type: 'message' | 'function_call';
  content?: Array<{ type: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface CodexResponse {
  id: string;
  output: CodexOutputItem[];
}

export interface CodexSSEEvent {
  type: string;
  response?: CodexResponse;
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// Codex API Constants
// ---------------------------------------------------------------------------

export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const DEFAULT_MODEL = 'gpt-5.1-codex';
export const MAX_TOOL_ROUNDS = 50;

export const CODEX_HEADERS = {
  BETA: 'OpenAI-Beta',
  BETA_VALUE: 'responses=experimental',
  ACCOUNT_ID: 'chatgpt-account-id',
  ORIGINATOR: 'originator',
  ORIGINATOR_VALUE: 'codex_cli_rs',
} as const;
