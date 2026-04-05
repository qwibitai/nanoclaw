import fs from 'fs';
import path from 'path';
import { SESSIONS_DIR } from '../shared/config.js';

interface SessionData {
  sessionId: string;
  lastUpdated: string;
}

export function getSessionId(groupId: string): string | undefined {
  const file = path.join(SESSIONS_DIR, `${groupId}.json`);
  try {
    const data: SessionData = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data.sessionId;
  } catch {
    return undefined;
  }
}

export function saveSessionId(groupId: string, sessionId: string): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `${groupId}.json`);
  const data: SessionData = {
    sessionId,
    lastUpdated: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
