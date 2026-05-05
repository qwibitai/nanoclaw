/**
 * Topic-title generation for auto-created threads (Phase 5.11).
 *
 * v2's Chat SDK Discord adapter auto-creates a thread on every new
 * top-level @mention. The default title is a generic Slack-style
 * stamp ("thread created 4/17 8pm"), which makes thread archaeology
 * painful. This module:
 *
 *  1. Generates a 2–5 word topic title from the inbound message via
 *     Haiku.
 *  2. Renames the freshly-created thread via a direct Discord REST
 *     PATCH (the @chat-adapter/discord surface doesn't expose a
 *     rename helper, so we go to the REST endpoint directly — this
 *     is intentionally narrow and fits v2's "fit-into, don't
 *     rebuild-v1" principle).
 *
 * Fire-and-forget from the router: never blocks inbound processing,
 * never errors user-visibly. Failures log and move on.
 */
import { callHaiku } from './llm.js';
import { log } from './log.js';

const MAX_TITLE_LENGTH = 100; // Discord's thread-name limit is 100 chars
const TITLE_PROMPT_CAP = 500; // Truncate input to keep Haiku latency low

/**
 * Generate a short topic title from a message. Returns undefined on
 * failure — caller should just skip the rename in that case.
 */
export async function generateTopicTitle(messageText: string): Promise<string | undefined> {
  const cleaned = messageText.replace(/@\w+\s*/g, '').trim();
  if (!cleaned) return undefined;

  try {
    const raw = await callHaiku(
      `Generate a concise 2–5 word title that captures the topic of this message. Reply with only the title — no quotes, no punctuation, no explanation.\n\nMessage: ${cleaned.slice(0, TITLE_PROMPT_CAP)}`,
    );
    const title = raw.replace(/\*+/g, '').trim().slice(0, MAX_TITLE_LENGTH);
    return title || undefined;
  } catch (err) {
    // callHaiku attaches the subprocess stderr to err.stderr (see llm.ts:30),
    // but the default JSON serializer of Error doesn't pick up custom props,
    // so surface it explicitly. Without this, every "Topic title generation
    // failed" warn looks like "Command failed: claude -p ..." with no clue
    // why claude actually exited non-zero (auth, timeout, rate limit, etc.).
    const stderr = (err as { stderr?: string }).stderr;
    log.warn('Topic title generation failed', { err, stderr });
    return undefined;
  }
}

/**
 * Rename a Discord thread via REST. `threadPlatformId` is the bridge-
 * encoded form (e.g. "discord:guildId:channelId:threadId") — we peel
 * off the bare thread ID (last segment) since Discord's REST endpoint
 * just wants that.
 */
async function renameDiscordThread(threadPlatformId: string, newName: string, botToken: string): Promise<void> {
  const parts = threadPlatformId.split(':');
  const threadId = parts[parts.length - 1];
  if (!threadId || !/^\d+$/.test(threadId)) {
    log.warn('renameDiscordThread: unrecognized thread id format', { threadPlatformId });
    return;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'nanoclaw-v2 (topic-title, v2)',
    },
    body: JSON.stringify({ name: newName }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<body unreadable>');
    log.warn('Discord thread rename failed', { threadId, status: res.status, body });
    return;
  }
  log.info('Discord thread renamed', { threadId, title: newName });
}

/**
 * Fire-and-forget: generate a title for the first message in a
 * freshly-created thread and rename the thread. Only runs when the
 * channel is Discord and `sessionCreated` is true (meaning this is
 * the first message in this thread from v2's perspective).
 *
 * Call from the router after `resolveSession` returns `created=true`.
 * Does not await internally — returns an already-scheduled promise so
 * the router can continue without blocking.
 */
export function maybeRenameNewThread(
  channelType: string,
  threadPlatformId: string | null,
  firstMessageText: string,
): void {
  if (!threadPlatformId) return;
  // Only Discord for now. Slack creates threads from the parent
  // message's ts (no rename possible without message edit). Telegram
  // is threadless. Others: add when they ship.
  if (!channelType.startsWith('discord')) return;

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    log.debug('maybeRenameNewThread: no DISCORD_BOT_TOKEN — skipping');
    return;
  }

  (async () => {
    const title = await generateTopicTitle(firstMessageText);
    if (!title) return;
    try {
      await renameDiscordThread(threadPlatformId, title, botToken);
    } catch (err) {
      log.warn('maybeRenameNewThread: rename threw', { err });
    }
  })();
}
