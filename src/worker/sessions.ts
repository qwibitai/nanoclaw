import { resolve } from '@std/path';
import { SESSIONS_DIR } from '../shared/config.ts';

interface SessionData {
  sessionId: string;
  lastUpdated: string;
}

export function getSessionId(groupId: string): string | undefined {
  const file = resolve(SESSIONS_DIR, `${groupId}.json`);
  try {
    const data: SessionData = JSON.parse(Deno.readTextFileSync(file));
    return data.sessionId;
  } catch {
    return undefined;
  }
}

export function saveSessionId(groupId: string, sessionId: string): void {
  Deno.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = resolve(SESSIONS_DIR, `${groupId}.json`);
  const data: SessionData = {
    sessionId,
    lastUpdated: new Date().toISOString(),
  };
  Deno.writeTextFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
