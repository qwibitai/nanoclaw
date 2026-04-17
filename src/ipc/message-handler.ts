import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

import type { IpcDeps } from './types.js';

/**
 * Process every *.json message file in the given directory. Each file
 * represents an agent-initiated outbound message; authorization is
 * enforced using the source group identity from the directory.
 *
 * Malformed files are moved to `errorsDir` so the watcher doesn't keep
 * retrying them forever.
 */
export async function processMessageFiles(
  messagesDir: string,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  errorsDir: string,
): Promise<void> {
  if (!fs.existsSync(messagesDir)) return;

  const registeredGroups = deps.registeredGroups();
  const messageFiles = fs
    .readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'));

  for (const file of messageFiles) {
    const filePath = path.join(messagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.type === 'message' && data.chatJid && data.text) {
        const targetGroup = registeredGroups[data.chatJid];
        const authorized =
          isMain || (targetGroup && targetGroup.folder === sourceGroup);
        if (authorized) {
          await deps.sendMessage(data.chatJid, data.text);
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'IPC message sent',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC message attempt blocked',
          );
        }
      }
      fs.unlinkSync(filePath);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error(
        { file, sourceGroup, err },
        'Error processing IPC message',
      );
      fs.mkdirSync(errorsDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorsDir, `${sourceGroup}-${file}`));
    }
  }
}
