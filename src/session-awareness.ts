import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';

export interface ActiveSession {
  containerId: string;
  started: string; // ISO 8601
  type: 'message' | 'task';
  repos: string[]; // empty for now — populated in future phases
}

export interface ActiveSessionsFile {
  sessions: ActiveSession[];
  updatedAt: string; // ISO 8601
}

const FILENAME = 'active_sessions.json';

/**
 * Read and parse the active sessions file for a group.
 * Returns an empty structure if the file doesn't exist or is corrupt.
 */
export function readActiveSessionsFile(
  groupFolder: string,
): ActiveSessionsFile {
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const filePath = path.join(ipcDir, FILENAME);

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Basic shape validation — don't trust the file blindly
    if (
      parsed &&
      Array.isArray(parsed.sessions) &&
      typeof parsed.updatedAt === 'string'
    ) {
      return parsed as ActiveSessionsFile;
    }
    return { sessions: [], updatedAt: '' };
  } catch {
    // File missing, unreadable, or corrupt — return empty
    return { sessions: [], updatedAt: '' };
  }
}

/**
 * Write (append) a new active session to the group's sessions file.
 * Creates the IPC directory if it doesn't exist.
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
export function writeActiveSessionsFile(
  groupFolder: string,
  session: ActiveSession,
): void {
  const ipcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(ipcDir, { recursive: true });

  const filePath = path.join(ipcDir, FILENAME);
  const existing = readActiveSessionsFile(groupFolder);

  existing.sessions.push(session);
  existing.updatedAt = new Date().toISOString();

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(existing, null, 2));
  fs.renameSync(tempPath, filePath);
}

/**
 * Remove a session by containerId from the group's sessions file.
 * If no sessions remain, writes an empty sessions array (doesn't delete the file).
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
export function removeActiveSession(
  groupFolder: string,
  containerId: string,
): void {
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const filePath = path.join(ipcDir, FILENAME);

  const existing = readActiveSessionsFile(groupFolder);
  existing.sessions = existing.sessions.filter(
    (s) => s.containerId !== containerId,
  );
  existing.updatedAt = new Date().toISOString();

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(existing, null, 2));
  fs.renameSync(tempPath, filePath);
}
