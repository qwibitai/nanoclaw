// src/management/protocol.ts

// --- Frame Types ---
export interface AuthFrame {
  type: 'auth';
  token: string;
}

export interface AuthOKFrame {
  type: 'auth';
  ok: boolean;
}

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload: Record<string, unknown>;
}

export type Frame =
  | AuthFrame
  | AuthOKFrame
  | RequestFrame
  | ResponseFrame
  | EventFrame;

// --- Constants ---
export const METHODS = [
  'health',
  'chat.send',
  'chat.abort',
  'sessions.list',
  'chat.history',
  'channels.status',
  'whatsapp.pair',
  'groups.sync',
  'groups.list',
] as const;
export type Method = (typeof METHODS)[number];

export const EVENTS = [
  'chat.delta',
  'chat.final',
  'chat.error',
  'agent.tool',
  'health',
  'channels.status',
  'whatsapp.qr',
  'groups.discovered',
] as const;
export type EventName = (typeof EVENTS)[number];

// --- Method Param Types ---
export interface ChatSendParams {
  sessionKey: string;
  message: string;
  resumeSessionId?: string; // Claude CLI session ID for --resume (multi-turn)
}
export interface ChatAbortParams {
  sessionKey: string;
  runId?: string;
}
export interface SessionsListParams {
  limit?: number;
}
export interface ChatHistoryParams {
  sessionKey: string;
  limit?: number;
}

// --- Event Payload Types ---
export interface ChatDeltaPayload {
  sessionKey: string;
  runId: string;
  content: string;
}
export interface ChatFinalPayload {
  sessionKey: string;
  runId: string;
  content: string;
  sessionId?: string; // Claude CLI session ID — caller stores this for --resume on next turn
  usage: { inputTokens: number; outputTokens: number };
}
export interface ChatErrorPayload {
  sessionKey: string;
  runId: string;
  error: string;
}
export interface AgentToolPayload {
  sessionKey: string;
  runId: string;
  tool: string;
  input: unknown;
  output: unknown;
}
