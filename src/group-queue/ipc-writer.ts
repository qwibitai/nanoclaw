import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

/**
 * Write a `{type:'message', text}` IPC file atomically (tmp → rename)
 * into the group's `input/` directory so the running container picks it up.
 * Returns `true` on success, `false` on any fs error.
 */
export function writeMessageIpc(groupFolder: string, text: string): boolean {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

/**
 * Write the `_close` sentinel that signals the container to finish and exit.
 * Best-effort: silently ignore any fs error.
 */
export function writeCloseSentinel(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    // ignore
  }
}
