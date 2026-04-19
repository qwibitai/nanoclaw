/**
 * User-facing abort flow for NanoClaw.
 * Handles stop/cancel/abort commands that kill the active container for a group.
 */
import { getTriggerPattern } from './config.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { stopContainer } from './container-runtime.js';
import { Channel, RegisteredGroup } from './types.js';

const STOP_KEYWORDS = /\b(stop|cancel|abort)\b/i;

/**
 * Detect whether the message body expresses a stop intent.
 *
 * Public channels (requiresTrigger !== false): the message must begin with the
 * group's trigger (e.g. "@sagri-ai") AND contain a stop keyword.
 *
 * DMs (requiresTrigger === false): a stop keyword anywhere is enough.
 */
export function isStopIntent(
  content: string,
  group: RegisteredGroup,
): boolean {
  const trimmed = content.trim();
  if (!STOP_KEYWORDS.test(trimmed)) return false;
  if (group.requiresTrigger === false) return true;
  const triggerPattern = getTriggerPattern(group.trigger);
  return triggerPattern.test(trimmed);
}

/**
 * Handle an abort request for a group.
 * Kills the active container if one is running, then posts a reply.
 */
export async function handleAbort(
  chatJid: string,
  queue: GroupQueue,
  channel: Channel,
): Promise<void> {
  const containerName = queue.getActiveContainerName(chatJid);

  if (!containerName) {
    logger.info({ chatJid }, 'Abort requested but no active container');
    await channel.sendMessage(chatJid, 'No task is currently running.');
    return;
  }

  logger.info({ chatJid, containerName }, 'Aborting active container');
  stopContainer(containerName);
  await channel.sendMessage(chatJid, 'Task aborted.');
}
