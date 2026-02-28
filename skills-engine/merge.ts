import { execFileSync, execSync } from 'child_process';

import { MergeResult } from './types.js';

export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run git merge-file to three-way merge files.
 * Modifies currentPath in-place.
 * Returns { clean: true, exitCode: 0 } on clean merge,
 * { clean: false, exitCode: N } on conflict (N = number of conflicts).
 */
export function mergeFile(
  currentPath: string,
  basePath: string,
  skillPath: string,
): MergeResult {
  try {
    execFileSync('git', ['merge-file', currentPath, basePath, skillPath], {
      stdio: 'pipe',
    });
    return { clean: true, exitCode: 0 };
  } catch (err: any) {
    const exitCode = err.status ?? 1;
    if (exitCode > 0) {
      // Positive exit code = number of conflicts
      return { clean: false, exitCode };
    }
    // Negative exit code = error
    throw new Error(`git merge-file failed: ${err.message}`);
  }
}
