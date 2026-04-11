import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

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

function assertValidIpcNamespaceKey(key: string): void {
  if (!key) {
    throw new Error('IPC namespace key must not be empty');
  }
  if (key !== key.trim()) {
    throw new Error('IPC namespace key must not include surrounding spaces');
  }
  if (key.includes('\0')) {
    throw new Error('IPC namespace key must not include NUL bytes');
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

/**
 * IPC ネームスペース用に chat JID をエンコードします。
 * 例: dc:123 -> dc%3A123
 */
export function encodeIpcNamespaceKey(groupJid: string): string {
  assertValidIpcNamespaceKey(groupJid);
  return encodeURIComponent(groupJid);
}

/**
 * IPC ネームスペース名を chat JID にデコードします。
 * 無効な値は null を返します。
 */
export function decodeIpcNamespaceKey(namespace: string): string | null {
  if (!namespace || namespace !== namespace.trim()) return null;
  try {
    const decoded = decodeURIComponent(namespace);
    assertValidIpcNamespaceKey(decoded);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * chat JID 単位の IPC ディレクトリを安全に解決します。
 */
export function resolveGroupIpcPathByJid(groupJid: string): string {
  const namespace = encodeIpcNamespaceKey(groupJid);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, namespace);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
