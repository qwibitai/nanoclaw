import path from 'path';

import {
  DATA_DIR,
  GROUP_THREAD_KEY,
  GROUPS_DIR,
  WORKTREES_DIR,
} from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

// --- Thread ID validation ---

const THREAD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_THREAD_KEYS = new Set([GROUP_THREAD_KEY]);

export function assertValidThreadId(threadId: string): void {
  if (!threadId) throw new Error('Thread ID must not be empty');
  if (threadId.includes('/') || threadId.includes('\\'))
    throw new Error(`Thread ID contains path separator: "${threadId}"`);
  if (threadId.includes('..'))
    throw new Error(`Thread ID contains "..": "${threadId}"`);
  if (threadId.includes('\0')) throw new Error('Thread ID contains null byte');
  if (RESERVED_THREAD_KEYS.has(threadId))
    throw new Error(`Thread ID uses reserved key: "${threadId}"`);
  if (threadId.startsWith('__task_'))
    throw new Error(`Thread ID uses reserved prefix: "${threadId}"`);
  if (!THREAD_ID_PATTERN.test(threadId))
    throw new Error(`Thread ID contains invalid characters: "${threadId}"`);

  // Path containment check
  const resolved = path.resolve(WORKTREES_DIR, 'test', threadId);
  ensureWithinBase(path.resolve(WORKTREES_DIR, 'test'), resolved);
}

export function resolveWorktreePath(
  groupFolder: string,
  threadId: string,
): string {
  assertValidGroupFolder(groupFolder);
  assertValidThreadId(threadId);
  return path.join(WORKTREES_DIR, groupFolder, threadId);
}

export function resolveGroupIpcInputPath(
  groupFolder: string,
  threadKey: string,
): string {
  const ipcPath = resolveGroupIpcPath(groupFolder);
  const result = path.join(ipcPath, 'input', threadKey);
  ensureWithinBase(path.join(ipcPath, 'input'), result);
  return result;
}
