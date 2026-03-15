/**
 * slack-fetcher.ts
 *
 * Fetches Slack messages (channels, DMs, group DMs) since the last run and
 * writes a structured JSON snapshot to data/slack/latest.json.
 *
 * Stdout  → JSON output (for piping)
 * Stderr  → progress / diagnostic logging (captured by launchd)
 */

import path from 'path';
import { WebClient, LogLevel, type ConversationsListResponse } from '@slack/web-api';
import { getEnvVar, DATA_DIR } from './shared/config.js';
import { readState, writeState } from './shared/state.js';
import { writeJsonAtomic, mergeDailyArchive } from './shared/writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlackState {
  /** Map of channel/DM ID → latest Slack ts seen (string float) */
  cursors: Record<string, string>;
  /** Map of Slack user ID → display name */
  userCache: Record<string, string>;
  /** The bot user ID (U...) resolved once and cached */
  botUserId?: string;
}

interface OutputMessage {
  channel: string;
  sender: string;
  text: string;
  timestamp: string;  // ISO
  ts: string;         // Slack ts (float string)
  is_dm: boolean;
  mentions_user: boolean;
}

interface Output {
  fetched_at: string;
  period_start: string;
  messages: OutputMessage[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLACK_DIR = path.join(DATA_DIR, 'slack');
const STATE_PATH = path.join(SLACK_DIR, 'state.json');
const OUTPUT_PATH = path.join(SLACK_DIR, 'latest.json');

const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60; // 24 h
const MAX_RETRIES = 6;
const BASE_RETRY_MS = 1_000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  process.stderr.write('[slack-fetcher] ' + args.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// Rate-limit-aware API wrapper
// ---------------------------------------------------------------------------

/**
 * Call a Slack API function with exponential back-off on 429 / rate-limit errors.
 * Respects the `Retry-After` header when present.
 */
async function callWithBackoff<T>(
  fn: () => Promise<T>,
  label = 'api call',
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes('ratelimited') ||
          err.message.includes('rate_limited') ||
          (err as { code?: string }).code === 'slack_webapi_rate_limited');

      if (!isRateLimit || attempt >= MAX_RETRIES) {
        throw err;
      }

      // Try to honour the Retry-After header value embedded in the error.
      let waitMs: number;
      const retryAfter = (err as { retryAfter?: number }).retryAfter;
      if (typeof retryAfter === 'number' && retryAfter > 0) {
        waitMs = retryAfter * 1_000;
      } else {
        waitMs = BASE_RETRY_MS * Math.pow(2, attempt);
      }

      attempt++;
      log(`Rate-limited on ${label}. Waiting ${waitMs}ms (attempt ${attempt}/${MAX_RETRIES})…`);
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

async function resolveUserName(
  userId: string,
  cache: Record<string, string>,
  client: WebClient,
): Promise<string> {
  if (cache[userId]) return cache[userId];

  try {
    const res = await callWithBackoff(
      () => client.users.info({ user: userId }),
      `users.info(${userId})`,
    );
    const profile = res.user?.profile;
    const name =
      profile?.real_name ||
      profile?.display_name ||
      res.user?.name ||
      userId;
    cache[userId] = name;
    return name;
  } catch {
    cache[userId] = userId;
    return userId;
  }
}

// ---------------------------------------------------------------------------
// Channel name helpers
// ---------------------------------------------------------------------------

function channelDisplayName(
  conv: NonNullable<ConversationsListResponse['channels']>[number],
  dmUserName: string,
): string {
  if (conv.is_im) {
    // For IMs, use the other user's name as the channel display
    return dmUserName;
  }
  if (conv.is_mpim && conv.name) {
    // MPIM names look like "mpdm-alice--bob--charlie-1" — keep as-is but trim
    return conv.name;
  }
  const prefix = conv.is_private ? '' : '#';
  return `${prefix}${conv.name || conv.id}`;
}

// ---------------------------------------------------------------------------
// mentions_user detection
// ---------------------------------------------------------------------------

function detectMentionsUser(text: string, botUserId: string): boolean {
  if (!text) return false;
  // @here or @channel
  if (text.includes('<!here>') || text.includes('<!channel>')) return true;
  // Direct bot user mention: <@U12345>
  if (botUserId && text.includes(`<@${botUserId}>`)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('Starting…');

  // --- Tokens ---
  // Prefer user token for everything (acts as Tom, can read all joined channels)
  const userToken = getEnvVar('SLACK_USER_TOKEN');
  const botToken = getEnvVar('SLACK_BOT_TOKEN');
  const primaryToken = userToken || botToken;

  if (!primaryToken) {
    process.stderr.write(
      '[slack-fetcher] ERROR: Neither SLACK_USER_TOKEN nor SLACK_BOT_TOKEN is set. ' +
      'Add one to your .env file or environment and retry.\n',
    );
    process.exit(1);
  }

  if (userToken) {
    log('Using user token (acting as Tom).');
  } else {
    log('No user token — falling back to bot token.');
  }

  // Single client for all API calls
  const client = new WebClient(primaryToken, { logLevel: LogLevel.ERROR });

  // --- State ---
  const state = readState<SlackState>(STATE_PATH);
  if (!state.cursors) state.cursors = {};
  if (!state.userCache) state.userCache = {};

  // --- Resolve authenticated user ID (once, then cache) ---
  // With a user token this is Tom's ID; with a bot token it's the bot's.
  if (!state.botUserId) {
    try {
      const authRes = await callWithBackoff(
        () => client.auth.test(),
        'auth.test',
      );
      state.botUserId = authRes.user_id as string | undefined;
      log(`Authenticated user ID: ${state.botUserId}`);
    } catch (err) {
      log(`Warning: could not resolve user ID: ${(err as Error).message}`);
    }
  }
  const authUserId = state.botUserId ?? '';

  // Default oldest ts if no prior state (first run = last 24 h)
  const defaultOldest = String(
    (Date.now() / 1_000 - DEFAULT_LOOKBACK_SECONDS).toFixed(6),
  );

  // --- Discover channels ---
  log('Listing conversations…');
  const allChannels: NonNullable<ConversationsListResponse['channels']> = [];

  let cursor: string | undefined;
  do {
    const page = await callWithBackoff(
      () =>
        client.conversations.list({
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      'conversations.list',
    );
    allChannels.push(...(page.channels ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  log(`Found ${allChannels.length} conversation(s).`);

  // --- Fetch messages ---
  const allMessages: OutputMessage[] = [];
  let oldestFetchedTs: number = Date.now() / 1_000;

  for (const conv of allChannels) {
    const channelId = conv.id;
    if (!channelId) continue;

    const isIm = !!conv.is_im;
    const oldest = state.cursors[channelId] ?? defaultOldest;

    // For DMs, try to resolve the other participant's name up-front
    let dmUserName = '';
    if (isIm && conv.user) {
      dmUserName = await resolveUserName(conv.user, state.userCache, client);
    }

    const displayName = channelDisplayName(conv, dmUserName);

    // Choose the right client for history
    const histClient = isIm ? client : client;

    log(`Fetching history for ${displayName} (${channelId}) since ts=${oldest}…`);

    let histCursor: string | undefined;
    let latestSeen: string = oldest;
    let pageCount = 0;

    do {
      let page;
      try {
        page = await callWithBackoff(
          () =>
            histClient.conversations.history({
              channel: channelId,
              oldest,
              inclusive: false,
              limit: 200,
              ...(histCursor ? { cursor: histCursor } : {}),
            }),
          `conversations.history(${channelId})`,
        );
      } catch (err: unknown) {
        // channel_not_found, not_in_channel, etc. — skip gracefully
        log(`  Skipping ${displayName}: ${(err as Error).message}`);
        break;
      }

      const msgs = page.messages ?? [];
      pageCount++;

      for (const msg of msgs) {
        // Skip subtypes (joins, leaves, bot_messages without text, etc.)
        // but keep bot_message if it has text
        if (msg.subtype && msg.subtype !== 'bot_message') continue;

        const ts = msg.ts ?? '';
        if (!ts) continue;

        const tsFloat = parseFloat(ts);
        if (tsFloat < oldestFetchedTs) oldestFetchedTs = tsFloat;

        // Track latest ts for cursor update
        if (!latestSeen || ts > latestSeen) latestSeen = ts;

        // Resolve sender
        const userId = msg.user ?? msg.bot_id ?? '';
        const sender = userId
          ? await resolveUserName(userId, state.userCache, client)
          : 'Unknown';

        const text = msg.text ?? '';

        allMessages.push({
          channel: displayName,
          sender,
          text,
          timestamp: new Date(tsFloat * 1_000).toISOString(),
          ts,
          is_dm: isIm,
          mentions_user: detectMentionsUser(text, authUserId),
        });
      }

      histCursor = page.response_metadata?.next_cursor || undefined;
    } while (histCursor);

    log(`  ${displayName}: fetched ${pageCount} page(s).`);

    // Update cursor to latest seen ts for next run
    if (latestSeen && latestSeen > (state.cursors[channelId] ?? '0')) {
      state.cursors[channelId] = latestSeen;
    }
  }

  // --- Sort newest first ---
  allMessages.sort((a, b) => {
    const aTs = parseFloat(a.ts);
    const bTs = parseFloat(b.ts);
    return bTs - aTs;
  });

  log(`Total messages collected: ${allMessages.length}`);

  // --- Build output ---
  const periodStartIso = new Date(oldestFetchedTs * 1_000).toISOString();
  const fetchedAt = new Date().toISOString();

  const output: Output = {
    fetched_at: fetchedAt,
    period_start: allMessages.length > 0 ? periodStartIso : new Date(
      (Date.now() / 1_000 - DEFAULT_LOOKBACK_SECONDS) * 1_000,
    ).toISOString(),
    messages: allMessages,
  };

  // --- Write latest snapshot ---
  writeJsonAtomic(OUTPUT_PATH, output);
  log(`Wrote ${allMessages.length} message(s) to ${OUTPUT_PATH}`);

  // --- Write daily archives (rolling 7 days) ---
  const daysDir = path.join(SLACK_DIR, 'days');
  mergeDailyArchive(
    daysDir,
    allMessages,
    (msg) => new Date(msg.timestamp),
    (msg) => msg.ts,
  );
  log(`Updated daily archives in ${daysDir}`);

  // --- Persist state ---
  writeState(STATE_PATH, state as unknown as Record<string, unknown>);
  log('State updated.');
  log('Done.');
}

main().catch((err) => {
  process.stderr.write('[slack-fetcher] FATAL: ' + (err instanceof Error ? err.stack : String(err)) + '\n');
  process.exit(1);
});
