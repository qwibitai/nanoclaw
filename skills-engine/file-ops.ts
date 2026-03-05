import fs from 'fs';
import path from 'path';
import type { FileOperation, FileOpsResult } from './types.js';

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
        throw new Error(`Invalid file operation path: "${candidateAbsPath}"`);
      }
      current = parent;
    }
  }
}

function resolveRealPathWithSymlinkAwareAnchor(
  candidateAbsPath: string,
): string {
  const anchorPath = nearestExistingPathOrSymlink(candidateAbsPath);
  const anchorStat = fs.lstatSync(anchorPath);
  let realAnchor: string;

  if (anchorStat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(anchorPath);
    const linkResolved = path.resolve(path.dirname(anchorPath), linkTarget);
    realAnchor = fs.realpathSync(linkResolved);
  } else {
    realAnchor = fs.realpathSync(anchorPath);
  }

  const relativeRemainder = path.relative(anchorPath, candidateAbsPath);
  return relativeRemainder
    ? path.resolve(realAnchor, relativeRemainder)
    : realAnchor;
}

function safePath(projectRoot: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    return null;
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (!isWithinRoot(root, resolved)) {
    return null;
  }
  if (resolved === root) {
    return null;
  }

  const realRoot = fs.realpathSync(root);
  const realParent = resolveRealPathWithSymlinkAwareAnchor(
    path.dirname(resolved),
  );
  if (!isWithinRoot(realRoot, realParent)) {
    return null;
  }

  return resolved;
}

export function executeFileOps(
  ops: FileOperation[],
  projectRoot: string,
): FileOpsResult {
  const result: FileOpsResult = {
    success: true,
    executed: [],
    warnings: [],
    errors: [],
  };

  const root = path.resolve(projectRoot);

  for (const op of ops) {
    switch (op.type) {
      case 'rename': {
        if (!op.from || !op.to) {
          result.errors.push(`rename: requires 'from' and 'to'`);
          result.success = false;
          return result;
        }
        const fromPath = safePath(root, op.from);
        const toPath = safePath(root, op.to);
        if (!fromPath) {
          result.errors.push(`rename: path escapes project root: ${op.from}`);
          result.success = false;
          return result;
        }
        if (!toPath) {
          result.errors.push(`rename: path escapes project root: ${op.to}`);
          result.success = false;
          return result;
        }
        if (!fs.existsSync(fromPath)) {
          result.errors.push(`rename: source does not exist: ${op.from}`);
          result.success = false;
          return result;
        }
        if (fs.existsSync(toPath)) {
          result.errors.push(`rename: target already exists: ${op.to}`);
          result.success = false;
          return result;
        }
        fs.renameSync(fromPath, toPath);
        result.executed.push(op);
        break;
      }

      case 'delete': {
        if (!op.path) {
          result.errors.push(`delete: requires 'path'`);
          result.success = false;
          return result;
        }
        const delPath = safePath(root, op.path);
        if (!delPath) {
          result.errors.push(`delete: path escapes project root: ${op.path}`);
          result.success = false;
          return result;
        }
        if (!fs.existsSync(delPath)) {
          result.warnings.push(
            `delete: file does not exist (skipped): ${op.path}`,
          );
          result.executed.push(op);
          break;
        }
        fs.unlinkSync(delPath);
        result.executed.push(op);
        break;
      }

      case 'move': {
        if (!op.from || !op.to) {
          result.errors.push(`move: requires 'from' and 'to'`);
          result.success = false;
          return result;
        }
        const srcPath = safePath(root, op.from);
        const dstPath = safePath(root, op.to);
        if (!srcPath) {
          result.errors.push(`move: path escapes project root: ${op.from}`);
          result.success = false;
          return result;
        }
        if (!dstPath) {
          result.errors.push(`move: path escapes project root: ${op.to}`);
          result.success = false;
          return result;
        }
        if (!fs.existsSync(srcPath)) {
          result.errors.push(`move: source does not exist: ${op.from}`);
          result.success = false;
          return result;
        }
        if (fs.existsSync(dstPath)) {
          result.errors.push(`move: target already exists: ${op.to}`);
          result.success = false;
          return result;
        }
        const dstDir = path.dirname(dstPath);
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
        }
        fs.renameSync(srcPath, dstPath);
        result.executed.push(op);
        break;
      }

      default: {
        result.errors.push(
          `unknown operation type: ${(op as FileOperation).type}`,
        );
        result.success = false;
        return result;
      }
    }
  }

  return result;
}
