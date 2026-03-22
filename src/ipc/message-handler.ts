import type pino from 'pino';

import { logger } from '../logger.js';
import type { IpcDeps } from '../ipc.js';
import type { RegisteredGroup } from '../types.js';

/**
 * Handle message-related IPC commands.
 */
export async function handleMessageIpc(
  data: { type: string; chatJid?: string; text?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
  log?: pino.Logger,
): Promise<void> {
  const _log = log ?? logger;

  if (data.type === 'message' && data.chatJid && data.text) {
    // Authorization: verify this group can send to this chatJid
    const targetGroup = registeredGroups[data.chatJid];
    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      await deps.sendMessage(data.chatJid, data.text);
      _log.info({ chatJid: data.chatJid }, 'IPC message sent');
    } else {
      _log.warn(
        { chatJid: data.chatJid },
        'Unauthorized IPC message attempt blocked',
      );
    }
  }
}
