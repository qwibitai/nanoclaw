import fs from 'fs';
import path from 'path';

import type { Api } from 'grammy';

import { resolveGroupFolderPath } from '../../group-folder.js';
import { logger } from '../../logger.js';

/**
 * Download a Telegram file to the group's attachments directory.
 * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
 * or null if the download fails.
 */
export async function downloadTelegramFile(
  api: { getFile: Api['getFile'] },
  botToken: string,
  fileId: string,
  groupFolder: string,
  filename: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'Telegram getFile returned no file_path');
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });

    // Sanitize filename and add extension from Telegram's file_path if missing
    const tgExt = path.extname(file.file_path);
    const localExt = path.extname(filename);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = localExt ? safeName : `${safeName}${tgExt}`;
    const destPath = path.join(attachDir, finalName);

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      logger.warn(
        { fileId, status: resp.status },
        'Telegram file download failed',
      );
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(destPath, buffer);

    logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
    return `/workspace/group/attachments/${finalName}`;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.error({ fileId, err }, 'Failed to download Telegram file');
    return null;
  }
}
