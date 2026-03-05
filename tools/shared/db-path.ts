import fs from 'fs';
import path from 'path';

/**
 * Resolve the messages.db path in both host and container contexts.
 * Host: cwd is the project root, DB at ./store/messages.db
 * Container: cwd is /workspace/group, DB at /workspace/project/store/messages.db
 */
export function getDbPath(): string {
  const candidates = [
    path.join(process.cwd(), 'store', 'messages.db'),
    '/workspace/project/store/messages.db',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // Fall back to cwd-based path (will error with "not found")
}
