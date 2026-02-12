/**
 * Cross-backend file transfer for NanoClaw.
 * Copies files between agents running on different backends
 * (e.g., local Apple Container → Sprites cloud, or vice versa).
 */

import path from 'path';

import { resolveBackend } from './backends/index.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface FileTransferRequest {
  sourceGroup: RegisteredGroup;
  targetGroup: RegisteredGroup;
  /** Paths relative to /workspace/group/ */
  files: string[];
  /** push = source→target, pull = target→source */
  direction: 'push' | 'pull';
}

/**
 * Transfer files between two agents, potentially across different backends.
 * Files are placed at /workspace/shared/{sourceFolder}/{basename} on the target.
 */
export async function transferFiles(req: FileTransferRequest): Promise<{ transferred: number; errors: string[] }> {
  const sourceBackend = resolveBackend(req.sourceGroup);
  const targetBackend = resolveBackend(req.targetGroup);

  const from = req.direction === 'push' ? req.sourceGroup : req.targetGroup;
  const to = req.direction === 'push' ? req.targetGroup : req.sourceGroup;
  const fromBackend = req.direction === 'push' ? sourceBackend : targetBackend;
  const toBackend = req.direction === 'push' ? targetBackend : sourceBackend;

  let transferred = 0;
  const errors: string[] = [];

  for (const file of req.files) {
    try {
      const content = await fromBackend.readFile(from.folder, file);
      if (!content) {
        errors.push(`File not found: ${file}`);
        continue;
      }

      const destPath = path.join('shared', from.folder, path.basename(file));
      await toBackend.writeFile(to.folder, destPath, content);
      transferred++;

      logger.info(
        {
          file,
          from: from.folder,
          to: to.folder,
          fromBackend: fromBackend.name,
          toBackend: toBackend.name,
        },
        'File transferred between agents',
      );
    } catch (err) {
      const msg = `Failed to transfer ${file}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logger.warn({ file, from: from.folder, to: to.folder, error: err }, 'File transfer failed');
    }
  }

  return { transferred, errors };
}
