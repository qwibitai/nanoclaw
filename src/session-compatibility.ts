import { createHash } from 'crypto';

export interface SessionCompatibilityEntry {
  path: string;
  content: string;
}

export function buildSessionContextVersion(input: {
  salt: string;
  entries: SessionCompatibilityEntry[];
}): string {
  const hash = createHash('sha256');
  hash.update(input.salt);

  for (const entry of [...input.entries].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    hash.update('\nFILE:');
    hash.update(entry.path);
    hash.update('\n');
    hash.update(entry.content);
  }

  return hash.digest('hex');
}

export function shouldInvalidateStoredSession(input: {
  sessionId?: string | null;
  storedVersion?: string | null;
  currentVersion?: string | null;
}): boolean {
  if (!input.sessionId || !input.currentVersion) return false;
  return input.storedVersion !== input.currentVersion;
}
