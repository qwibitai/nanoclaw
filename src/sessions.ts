import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { clearSession, getSession } from './db.js';
import { logger } from './logger.js';

/**
 * Path to the Claude Code session JSONL file for a given group + session.
 *
 * The `-workspace-group` segment mirrors the container's working directory
 * (`/workspace/group`, set in src/container-runner.ts) — Claude Code derives
 * the projects/ subfolder from cwd. Keep this helper in sync with any changes
 * to the container mount layout AND with scripts/cleanup-sessions.sh, which
 * encodes the same path pattern.
 */
export function sessionJsonlPath(
  groupFolder: string,
  sessionId: string,
): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

/**
 * Return the group's stored session ID if (and only if) its backing JSONL
 * still exists on disk. If the DB points at a session whose file is missing,
 * clear the DB row and return undefined so the next container launch starts
 * a fresh session instead of failing with "No conversation found".
 */
export function resolveSessionId(groupFolder: string): string | undefined {
  const sessionId = getSession(groupFolder);
  if (!sessionId) return undefined;

  const jsonlFile = sessionJsonlPath(groupFolder, sessionId);

  if (fs.existsSync(jsonlFile)) {
    return sessionId;
  }

  logger.warn(
    { groupFolder, sessionId, jsonlFile },
    'Stored session JSONL is missing; clearing stale pointer',
  );
  clearSession(groupFolder);
  return undefined;
}

/**
 * True iff the given error was caused by Claude Code failing to resume a
 * session that no longer exists on disk.
 */
export function isSessionNotFoundError(error: unknown): boolean {
  if (typeof error !== 'string' || error.length === 0) return false;
  return error.includes('No conversation found with session ID');
}
