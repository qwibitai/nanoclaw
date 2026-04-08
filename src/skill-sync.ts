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
    try {
      fs.cpSync(src, dst, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EACCES') throw err;
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
}
