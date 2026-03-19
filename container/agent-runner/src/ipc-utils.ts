/**
 * IPC utility functions — pure filesystem operations with no SDK dependencies.
 * Extracted from ipc-mcp-stdio.ts for testability (kaizen #167).
 */

import fs from 'fs';
import path from 'path';

/** Poll for a result file written by the host. Returns parsed JSON or null on timeout. */
export async function pollForResult(
  dir: string,
  requestId: string,
  maxAttempts = 30,
): Promise<Record<string, unknown> | null> {
  const resultFile = path.join(dir, `${requestId}.json`);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      }
    } catch {
      // File might not exist yet, keep polling
    }
  }
  return null;
}

export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}
