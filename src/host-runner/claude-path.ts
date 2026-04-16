import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

let cachedClaudePath: string | undefined;

/**
 * Resolve the path to the `claude` CLI, preferring well-known install
 * locations over `which` to avoid spawning a subprocess on every call.
 * Result is memoized across calls.
 */
export function findClaudePath(): string {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cachedClaudePath = p;
      return p;
    }
  }
  try {
    cachedClaudePath = execSync('which claude', { encoding: 'utf8' }).trim();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    cachedClaudePath = '';
  }
  return cachedClaudePath;
}

/** @internal - for tests only. */
export function _resetClaudePathCache(): void {
  cachedClaudePath = undefined;
}
