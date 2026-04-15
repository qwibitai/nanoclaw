import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface SessionMessage {
  role: string;
  content: string | unknown[];
  [key: string]: unknown;
}

const MAX_SESSION_MESSAGES = 100;

export function loadSession(
  sessionDir: string,
  sessionId: string | null | undefined,
): SessionMessage[] {
  if (!sessionId) return [];
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveSession(
  sessionDir: string,
  sessionId: string | null | undefined,
  messages: SessionMessage[],
): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const id = sessionId ?? crypto.randomUUID();
  const filePath = path.join(sessionDir, `${id}.json`);
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
  return id;
}
