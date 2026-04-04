/**
 * Unified session format for NanoClaw agent runners.
 * Both Claude and Ollama runners write to this format, enabling
 * future on-the-fly model switching with conversation history preserved.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface UnifiedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: UnifiedToolCall[];
  toolCallId?: string;
  timestamp: string;
  provider: 'claude' | 'ollama';
  model?: string;
}

export interface UnifiedSession {
  id: string;
  messages: UnifiedMessage[];
  createdAt: string;
  lastProvider: 'claude' | 'ollama';
}

const MAX_MESSAGES = 100;
const SESSIONS_DIR = '/workspace/group/.sessions';

function sessionPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

export function createSession(provider: 'claude' | 'ollama'): UnifiedSession {
  const id = `session-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    messages: [],
    createdAt: new Date().toISOString(),
    lastProvider: provider,
  };
}

export function loadSession(sessionId: string): UnifiedSession | null {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveSession(session: UnifiedSession): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const p = sessionPath(session.id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, p);
}

export function appendMessage(
  session: UnifiedSession,
  msg: Omit<UnifiedMessage, 'timestamp'>,
): void {
  session.messages.push({
    ...msg,
    timestamp: new Date().toISOString(),
  });
  // Cap to prevent unbounded growth
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

/** Convert unified session messages to Ollama /api/chat format. */
export function getMessagesForOllama(
  session: UnifiedSession,
): Array<{
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_call_id?: string;
}> {
  return session.messages.map((msg) => {
    const base: {
      role: typeof msg.role;
      content: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: Record<string, unknown> };
      }>;
      tool_call_id?: string;
    } = {
      role: msg.role,
      content: msg.content,
    };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      base.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (msg.toolCallId) {
      base.tool_call_id = msg.toolCallId;
    }
    return base;
  });
}

/** Generate a text summary of the session for context injection (e.g. when switching providers). */
export function getContextSummary(session: UnifiedSession): string {
  const lines: string[] = [];
  for (const msg of session.messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') continue;
    const prefix = msg.role === 'user' ? 'User' : 'Assistant';
    const text =
      msg.content.length > 500
        ? msg.content.slice(0, 500) + '...'
        : msg.content;
    lines.push(`${prefix}: ${text}`);
  }
  return lines.join('\n\n');
}
