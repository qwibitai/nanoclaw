import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete images older than maxAgeMs from all group images/ directories.
 * Returns the number of files deleted.
 */
export function cleanupOldImages(maxAgeMs = THIRTY_DAYS_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(GROUPS_DIR);
  } catch {
    // groups/ dir doesn't exist yet — nothing to clean up
    return 0;
  }

  for (const folder of groupFolders) {
    if (!isValidGroupFolder(folder)) continue;

    const imagesDir = path.join(GROUPS_DIR, folder, 'images');

    let files: string[];
    try {
      files = fs.readdirSync(imagesDir);
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(imagesDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;

      if (stat.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(filePath);
          logger.info(
            {
              group: folder,
              file,
              agedays: Math.floor((Date.now() - stat.mtimeMs) / 86400000),
            },
            'Deleted old image',
          );
          deleted++;
        } catch (err) {
          logger.warn(
            { group: folder, file, err },
            'Failed to delete old image',
          );
        }
      }
    }
  }

  if (deleted > 0) {
    logger.info({ deleted }, 'Image cleanup complete');
  } else {
    logger.debug('Image cleanup: no files to delete');
  }

  return deleted;
}

/**
 * Start a weekly interval that deletes images older than 30 days.
 * @returns Timer ID that can be cleared with clearInterval()
 */
export function startImageCleanup(): NodeJS.Timeout {
  // Run once at startup (catches any backlog), then weekly
  cleanupOldImages();

  return setInterval(() => {
    cleanupOldImages();
  }, SEVEN_DAYS_MS);
}
