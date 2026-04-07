/**
 * Telegram channel driver — user-facing factory.
 *
 * @example
 * ```typescript
 * import { telegram } from '@boxlite-ai/agentlite/channels/telegram';
 * agent.addChannel('telegram', telegram({ token: process.env.TG_TOKEN! }));
 * ```
 */

import type { ChannelDriver } from '../channel-driver.js';

/** Options for the Telegram channel. */
export interface TelegramOptions {
  /** Telegram bot token from BotFather. */
  token: string;
}

/**
 * Create a Telegram channel driver.
 * Internally wraps the TelegramChannel implementation — all details hidden.
 */
export function telegram(opts: TelegramOptions): ChannelDriver {
  // Return a lazy proxy — the real TelegramChannel is created when
  // the agent calls start(). This keeps the internal implementation
  // out of the user-facing module graph at import time.
  return {
    _type: 'telegram' as const,
    _opts: opts,
  } as unknown as ChannelDriver;
}

// Internal: used by agent-impl to detect and unwrap telegram config
/** @internal */
export function isTelegramConfig(
  driver: unknown,
): driver is { _type: 'telegram'; _opts: TelegramOptions } {
  return (
    typeof driver === 'object' &&
    driver !== null &&
    '_type' in driver &&
    (driver as { _type: string })._type === 'telegram'
  );
}
