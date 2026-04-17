import { logger } from '../logger.js';
import { findChannel } from '../router.js';
import { startRemoteControl, stopRemoteControl } from '../remote-control.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';

export interface RemoteControlDeps {
  channels: Channel[];
  registeredGroups: Record<string, RegisteredGroup>;
}

/**
 * Handle `/remote-control` and `/remote-control-end` messages. Only the
 * main group may start/stop a session; everyone else is silently refused.
 */
export async function handleRemoteControl(
  command: string,
  chatJid: string,
  msg: NewMessage,
  deps: RemoteControlDeps,
): Promise<void> {
  const group = deps.registeredGroups[chatJid];
  if (!group?.isMain) {
    logger.warn(
      { chatJid, sender: msg.sender },
      'Remote control rejected: not main group',
    );
    return;
  }

  const channel = findChannel(deps.channels, chatJid);
  if (!channel) return;

  if (command === '/remote-control') {
    const result = await startRemoteControl(msg.sender, chatJid, process.cwd());
    if (result.ok) {
      await channel.sendMessage(chatJid, result.url);
    } else {
      await channel.sendMessage(
        chatJid,
        `Remote Control failed: ${result.error}`,
      );
    }
  } else {
    const result = stopRemoteControl();
    if (result.ok) {
      await channel.sendMessage(chatJid, 'Remote Control session ended.');
    } else {
      await channel.sendMessage(chatJid, result.error);
    }
  }
}
