/**
 * Session management for local LLMs
 * Stores conversation history for context continuity
 */

import fs from 'fs';
import path from 'path';
import type { ChatMessage } from './openai-client.js';

export interface SessionMessage extends ChatMessage {
  timestamp: string;
}

export interface SessionData {
  sessionId: string;
  provider: string;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
}

const SESSIONS_DIR = '/workspace/group/.llm-sessions';
const DEFAULT_CONTEXT_LIMIT = 10; // Last N messages to keep in context

/**
 * Ensure sessions directory exists
 */
function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

/**
 * Get session file path
 */
function getSessionPath(provider: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, `${provider}-${sessionId}.json`);
}

/**
 * Load session from disk
 */
export function loadSession(provider: string, sessionId: string): SessionData | null {
  ensureSessionsDir();
  const filepath = getSessionPath(provider, sessionId);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load session ${sessionId}:`, error);
    return null;
  }
}

/**
 * Save session to disk
 */
export function saveSession(data: SessionData): void {
  ensureSessionsDir();
  const filepath = getSessionPath(data.provider, data.sessionId);

  data.updatedAt = new Date().toISOString();

  try {
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  } catch (error) {
    console.error(`Failed to save session ${data.sessionId}:`, error);
    throw error;
  }
}

/**
 * Create new session
 */
export function createSession(provider: string, sessionId: string): SessionData {
  const now = new Date().toISOString();
  return {
    sessionId,
    provider,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add message to session
 */
export function addMessage(
  session: SessionData,
  role: 'system' | 'user' | 'assistant',
  content: string,
): SessionData {
  const message: SessionMessage = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };

  session.messages.push(message);
  return session;
}

/**
 * Get messages for context window
 * Returns last N messages, respecting context limit
 */
export function getContextMessages(
  session: SessionData,
  contextLimit: number = DEFAULT_CONTEXT_LIMIT,
): ChatMessage[] {
  const messages = session.messages.slice(-contextLimit);
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * Trim old messages to keep session size manageable
 */
export function trimSession(
  session: SessionData,
  maxMessages: number = DEFAULT_CONTEXT_LIMIT * 2,
): SessionData {
  if (session.messages.length > maxMessages) {
    // Keep first message (usually system prompt) + last N messages
    const firstMessage = session.messages[0];
    const recentMessages = session.messages.slice(-maxMessages + 1);
    session.messages = [firstMessage, ...recentMessages];
  }
  return session;
}

/**
 * Count conversation turns (user + assistant pairs)
 */
export function countTurns(session: SessionData): number {
  let turns = 0;
  for (const msg of session.messages) {
    if (msg.role === 'user') turns++;
  }
  return turns;
}

/**
 * List all sessions for a provider
 */
export function listSessions(provider: string): string[] {
  ensureSessionsDir();

  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    const prefix = `${provider}-`;

    return files
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => f.slice(prefix.length, -5)); // Remove prefix and .json
  } catch (error) {
    console.error('Failed to list sessions:', error);
    return [];
  }
}

/**
 * Delete session
 */
export function deleteSession(provider: string, sessionId: string): boolean {
  const filepath = getSessionPath(provider, sessionId);

  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
      return true;
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
      return false;
    }
  }

  return false;
}
