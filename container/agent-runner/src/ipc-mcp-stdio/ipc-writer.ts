import fs from 'fs';
import path from 'path';

/**
 * Atomically write an IPC file by creating a `.tmp` then renaming it
 * into place, so readers (host-side watcher) never see a partial JSON.
 * Returns the final filename (not full path).
 */
export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}
