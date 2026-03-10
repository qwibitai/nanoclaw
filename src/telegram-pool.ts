/**
 * Telegram Bot Pool — send-only Api instances for agent swarm identities.
 *
 * Each pool bot is a Grammy Api instance (no polling). When a subagent sends
 * a message with a `sender` identity, the pool assigns a dedicated bot and
 * renames it to match the sender's role so it appears with that identity in
 * the Telegram group.
 *
 * Mapping is stable within a session: {groupFolder}:{senderName} → pool index.
 * Resets on service restart (bots get reassigned fresh).
 */

import { Api } from 'grammy';

import { logger } from './logger.js';

const poolApis: Api[] = [];

// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances from a list of bot tokens.
 * Call once at startup when TELEGRAM_BOT_POOL is configured.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot — check token');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via the pool bot assigned to `sender` in `groupFolder`.
 * On first use the bot is renamed to match the sender identity.
 * Falls back to `fallback` when no pool bots are available.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  fallback: (chatId: string, text: string) => Promise<void>,
): Promise<void> {
  if (poolApis.length === 0) {
    await fallback(chatId, text);
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      // Brief pause so Telegram propagates the name change before the first message
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  const numericId = chatId.replace(/^tg:/, '');
  const MAX_LENGTH = 4096;

  try {
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export function getPoolSize(): number {
  return poolApis.length;
}
