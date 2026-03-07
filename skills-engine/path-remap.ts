import fs from 'fs';
import path from 'path';

import { readState, writeState } from './state.js';

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

function nearestExistingPathOrSymlink(candidateAbsPath: string): string {
  let current = candidateAbsPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Invalid remap path: "${candidateAbsPath}"`);
      }
      current = parent;
    }
  }
}

function toSafeProjectRelativePath(
  candidatePath: string,
  projectRoot: string,
): string {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new Error(`Invalid remap path: "${candidatePath}"`);
  }

  const root = path.resolve(projectRoot);
  const realRoot = fs.realpathSync(root);
  const resolved = path.resolve(root, candidatePath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path remap escapes project root: "${candidatePath}"`);
  }
  if (resolved === root) {
    throw new Error(`Path remap points to project root: "${candidatePath}"`);
  }

  // Detect symlink escapes by resolving the nearest existing ancestor/symlink.
  const anchorPath = nearestExistingPathOrSymlink(resolved);
  const anchorStat = fs.lstatSync(anchorPath);
  let realAnchor: string;

  if (anchorStat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(anchorPath);
    const linkResolved = path.resolve(path.dirname(anchorPath), linkTarget);
    realAnchor = fs.realpathSync(linkResolved);
  } else {
    realAnchor = fs.realpathSync(anchorPath);
  }

  const relativeRemainder = path.relative(anchorPath, resolved);
  const realResolved = relativeRemainder
    ? path.resolve(realAnchor, relativeRemainder)
    : realAnchor;

  if (!isWithinRoot(realRoot, realResolved)) {
    throw new Error(
      `Path remap escapes project root via symlink: "${candidatePath}"`,
    );
  }

  return path.relative(realRoot, realResolved);
}

function sanitizeRemapEntries(
  remap: Record<string, string>,
  mode: 'throw' | 'drop',
): Record<string, string> {
  const projectRoot = process.cwd();
  const sanitized: Record<string, string> = {};

  for (const [from, to] of Object.entries(remap)) {
    try {
      const safeFrom = toSafeProjectRelativePath(from, projectRoot);
      const safeTo = toSafeProjectRelativePath(to, projectRoot);
      sanitized[safeFrom] = safeTo;
    } catch (err) {
      if (mode === 'throw') {
        throw err;
      }
    }
  }

  return sanitized;
}

export function resolvePathRemap(
  relPath: string,
  remap: Record<string, string>,
): string {
  const projectRoot = process.cwd();
  const safeRelPath = toSafeProjectRelativePath(relPath, projectRoot);
  const remapped = remap[safeRelPath] ?? remap[relPath];

  if (remapped === undefined) {
    return safeRelPath;
  }

  // Fail closed: if remap target is invalid, ignore remap and keep original path.
  try {
    return toSafeProjectRelativePath(remapped, projectRoot);
  } catch {
    return safeRelPath;
  }
}

export function loadPathRemap(): Record<string, string> {
  const state = readState();
  const remap = state.path_remap ?? {};
  return sanitizeRemapEntries(remap, 'drop');
}

export function recordPathRemap(remap: Record<string, string>): void {
  const state = readState();
  const existing = sanitizeRemapEntries(state.path_remap ?? {}, 'drop');
  const incoming = sanitizeRemapEntries(remap, 'throw');
  state.path_remap = { ...existing, ...incoming };
  writeState(state);
}
