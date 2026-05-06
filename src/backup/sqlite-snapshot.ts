/**
 * Take an online snapshot of a SQLite DB to a destination path. Uses
 * better-sqlite3's `.backup()`, which holds shared locks rather than
 * blocking writers — safe to call against the central DB while the host
 * is running, and against per-session DBs while a container is writing
 * (SQLite locking is filesystem-level, so bun:sqlite in the container
 * is correctly serialized).
 *
 * `unlink` the destination if it exists before invoking — `.backup()` will
 * happily append to whatever is at the path otherwise, producing a corrupt
 * file. Caller is responsible for parent dir existing.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

export async function snapshotSqlite(srcPath: string, dstPath: string): Promise<void> {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`SQLite snapshot source missing: ${srcPath}`);
  }
  if (fs.existsSync(dstPath)) {
    fs.unlinkSync(dstPath);
  }
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dstPath);
  } finally {
    src.close();
  }
}
