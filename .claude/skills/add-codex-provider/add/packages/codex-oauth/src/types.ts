/**
 * Type definitions for codex-oauth
 */

// ---------------------------------------------------------------------------
// OAuth Types
// ---------------------------------------------------------------------------

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in milliseconds
  account_id: string; // ChatGPT account ID extracted from JWT
}

export interface CodexAuthOptions {
  /** Path to store tokens (default: ~/.codex-oauth/tokens.json) */
  tokenPath?: string;
  /** Port for OAuth callback server (default: 1455) */
  callbackPort?: number;
  /** OAuth flow timeout in ms (default: 300000 = 5 min) */
  timeout?: number;
  /** Called with the OAuth URL when the callback server is ready */
  onAuthUrl?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// Model Types
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  baseModel: string;
  reasoning: ReasoningEffort;
  contextWindow: number;
  maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// API Types
// ---------------------------------------------------------------------------

export interface CodexChatOptions {
  /** Model ID or alias (default: gpt-5.3-codex) */
  model?: string;
  /** Reasoning effort override */
  reasoning?: ReasoningEffort;
  /** System instructions */
  instructions?: string;
  /** Tool definitions for function calling */
  tools?: CodexTool[];
  /** Additional fields to include in response */
  include?: string[];
}

export type CodexInputItem =
  | { role: 'developer'; content: string }
  | { role: 'user'; content: string | CodexContentPart[] }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface CodexContentPart {
  type: 'input_text' | 'input_image';
  text?: string;
  image_url?: string;
}

export interface CodexTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CodexRequest {
  model: string;
  input: CodexInputItem[];
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  tools?: CodexTool[];
  reasoning?: { effort: ReasoningEffort; summary?: 'auto' | 'concise' | 'detailed' };
  include?: string[];
}

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
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
  };
}

export interface CodexSSEEvent {
  type: string;
  response?: CodexResponse;
  error?: { message?: string; code?: string };
}
