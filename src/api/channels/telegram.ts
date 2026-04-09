/**
 * Telegram channel driver — user-facing factory.
 *
 * @example
 * ```typescript
 * import { telegram } from '@boxlite-ai/agentlite/channels/telegram';
 *
 * const agent = agentlite.getOrCreateAgent('main', {
 *   channels: { telegram: telegram({ token: process.env.TG_TOKEN! }) },
 * });
 * ```
 */

import type { ChannelDriverFactory } from '../channel-driver.js';

/** Options for the Telegram channel. */
export interface TelegramOptions {
  /** Telegram bot token from BotFather. */
  token: string;
  /** Assistant name for trigger matching. Default: 'Andy' */
  assistantName?: string;
  /** Groups directory for file downloads. Default: '' */
  groupsDir?: string;
}

/**
 * Create a Telegram channel driver factory.
 * The factory is called by the SDK at agent.start() time with callbacks.
 */
export function telegram(opts: TelegramOptions): ChannelDriverFactory {
  const assistantName = opts.assistantName ?? 'Andy';
  const escaped = assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const triggerPattern = new RegExp(`^@${escaped}\\b`, 'i');

  return async (config) => {
    const { TelegramChannel } = await import('../../channels/telegram.js');
    const channel = new TelegramChannel(opts.token, {
      onMessage: config.onMessage as any,
      onChatMetadata: config.onChatMetadata as any,
      registeredGroups: config.registeredGroups as any,
      groupsDir: opts.groupsDir ?? '',
      assistantName,
      triggerPattern,
    });
    return channel as any;
  };
}
