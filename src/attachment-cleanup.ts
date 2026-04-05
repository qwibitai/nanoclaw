/**
 * Periodic cleanup of downloaded attachments from group inbox/attachments directories.
 * Deletes files older than the configured TTL to prevent unbounded disk growth.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_DIRS = ['attachments', 'inbox'];

function cleanGroupAttachments(): void {
  const now = Date.now();
  let totalFreed = 0;
  let totalFiles = 0;

  try {
    const groups = fs.readdirSync(GROUPS_DIR).filter((f) => {
      try {
        return fs.statSync(path.join(GROUPS_DIR, f)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const group of groups) {
      for (const dirName of CLEANUP_DIRS) {
        const dir = path.join(GROUPS_DIR, group, dirName);
        if (!fs.existsSync(dir)) continue;

        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.startsWith('.')) continue;
            const filePath = path.join(dir, file);
            try {
              const stat = fs.statSync(filePath);
              if (!stat.isFile()) continue;
              if (now - stat.mtimeMs > ATTACHMENT_TTL_MS) {
                fs.unlinkSync(filePath);
                totalFreed += stat.size;
                totalFiles++;
              }
            } catch {
              /* skip files we can't stat */
            }
          }
        } catch {
          /* skip dirs we can't read */
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Attachment cleanup failed');
    return;
  }

  if (totalFiles > 0) {
    const freedKB = Math.round(totalFreed / 1024);
    logger.info(
      { files: totalFiles, freedKB },
      `[cleanup] Removed ${totalFiles} expired attachments (~${freedKB}K)`,
    );
  }
}

export function startAttachmentCleanup(): void {
  // Run once at startup (delayed 60s)
  setTimeout(cleanGroupAttachments, 60_000);
  // Then every hour
  setInterval(cleanGroupAttachments, CLEANUP_INTERVAL_MS);
}
