import path from 'path';

import { readState, writeState } from './state.js';

function toSafeProjectRelativePath(
  candidatePath: string,
  projectRoot: string,
): string {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    throw new Error(`Invalid remap path: "${candidatePath}"`);
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, candidatePath);
  if (
    !resolved.startsWith(root + path.sep) &&
    resolved !== root
  ) {
    throw new Error(`Path remap escapes project root: "${candidatePath}"`);
  }
  if (resolved === root) {
    throw new Error(`Path remap points to project root: "${candidatePath}"`);
  }

  return path.relative(root, resolved);
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
  const remapped =
    remap[safeRelPath] ??
    remap[relPath];

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
