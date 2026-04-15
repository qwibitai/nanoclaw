/**
 * Syncs skill directories into a destination .claude/skills/ folder.
 * Used by both container-runner and host-runner.
 */
import fs from 'fs';
import path from 'path';

/**
 * Copy skill subdirectories from `srcDir` into `dstDir`.
 * Only top-level directories are copied (files at the root are skipped).
 */
export function syncSkills(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    if (!fs.statSync(src).isDirectory()) continue;
    const dst = path.join(dstDir, entry);

    // If dst is a symlink (or points to the same real path as src),
    // cpSync throws "src and dest cannot be the same".  Remove it first
    // so we always copy fresh content.
    if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) {
      fs.rmSync(dst, { force: true });
    }

    try {
      // dereference: follow symlinks in src so we copy actual files,
      // not symlinks (important for container mode / SDK compatibility).
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EACCES') throw err;
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }
  }
}
