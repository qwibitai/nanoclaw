import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm']);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Delete audio attachments older than 30 days from all group attachment dirs.
 * Audio files use a timestamp prefix (e.g., "1712345678000-clip.m4a") which
 * encodes when they were saved.
 */
export function cleanupOldAudioAttachments(): void {
  const cutoff = Date.now() - RETENTION_MS;
  let deleted = 0;

  try {
    const groups = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });

    for (const group of groups) {
      if (!group.isDirectory()) continue;

      const attachDir = path.join(GROUPS_DIR, group.name, 'attachments');
      if (!fs.existsSync(attachDir)) continue;

      const files = fs.readdirSync(attachDir, { withFileTypes: true });

      for (const file of files) {
        if (file.isDirectory()) continue;

        const ext = path.extname(file.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext)) continue;

        // Extract timestamp from filename prefix (e.g., "1712345678000-clip.m4a")
        const tsMatch = file.name.match(/^(\d+)-/);
        if (!tsMatch) continue;

        const fileTs = parseInt(tsMatch[1], 10);
        if (fileTs < cutoff) {
          const filePath = path.join(attachDir, file.name);
          try {
            fs.unlinkSync(filePath);
            deleted++;
          } catch (err) {
            logger.warn({ err, path: filePath }, 'Failed to delete old audio attachment');
          }
        }
      }
    }

    if (deleted > 0) {
      logger.info({ deleted }, 'Cleaned up old audio attachments');
    }
  } catch (err) {
    logger.warn({ err }, 'Audio attachment cleanup failed');
  }
}
