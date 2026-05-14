/**
 * X-integration MCP tools (container side, NanoClaw v2).
 *
 * 25 tools total, in six families:
 *   - Read (8):    x_read_tweet, x_read_thread, x_read_user,
 *                  x_read_bookmarks, x_read_list, x_read_timeline,
 *                  x_read_notifications, x_search
 *   - Compose (3): x_post, x_reply, x_quote (with media + schedule_at)
 *   - Engage (9): x_like / x_unlike, x_retweet / x_unretweet,
 *                  x_bookmark / x_unbookmark, x_follow / x_unfollow,
 *                  x_delete_tweet (text-echo guard, see below)
 *   - Schedule (2): x_list_scheduled, x_cancel_scheduled
 *   - DM (3):     x_read_dm_inbox, x_read_dm_thread, x_send_dm
 *   - Bulk (1):   x_export_bookmarks (resumable CSV dump)
 *
 * Safety on x_delete_tweet: tool requires a `text_must_match` substring of
 * the tweet body. The host script reads the live tweet and refuses to
 * delete unless the substring is present. Guards against URL hallucinations
 * and copy-paste errors. No approval gate — consistent with the skill's
 * stance ("don't gate per action; wrap if you want approvals").
 *
 * Mechanism (mirrors mcp-tools/self-mod.ts): every tool writes a
 * kind:'system' row with content = JSON.stringify({action, requestId,
 * ...args}) and returns immediately. The host runs the action
 * asynchronously and notifies the agent with the result via
 * notifyAgent() → kind:'chat' row in inbound.db (which also wakes the
 * container, so the result lands on the next turn).
 *
 * Imports below are written for the install destination
 * container/agent-runner/src/mcp-tools/x-integration.ts.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const TWEET_MAX = 280;
const DM_MAX = 10000;
const READ_MAX = 50;
/** Higher cap for x_read_bookmarks: paginated walks pay a fixed
 *  re-scroll cost per call, so larger batches amortize better. */
const BOOKMARKS_READ_MAX = 100;
const MEDIA_MAX = 4;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// ── Factory ──────────────────────────────────────────────────

interface XToolSpec {
  /** Tool name as the agent sees it. */
  name: string;
  /** Tool description for the agent. */
  description: string;
  /** Raw JSON-Schema (matches mcp-tools/self-mod.ts shape — no zod). */
  inputSchema: Tool['inputSchema'];
  /** Action key — must match a registerDeliveryAction() in host.ts. */
  action: string;
  /** Pre-flight validation. Return error message string OR null if ok. */
  validate?: (args: Record<string, unknown>) => string | null;
  /** Map raw args → outbound-message payload. Defaults to identity. */
  buildPayload?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Override the "submitted" reply text. */
  submittedMessage?: string;
}

function makeXTool(spec: XToolSpec): McpToolDefinition {
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    },
    async handler(args) {
      if (spec.validate) {
        const validationError = spec.validate(args);
        if (validationError) return err(validationError);
      }
      const requestId = generateId(spec.name);
      const payload = spec.buildPayload ? spec.buildPayload(args) : args;
      writeMessageOut({
        id: requestId,
        kind: 'system',
        content: JSON.stringify({ action: spec.action, requestId, ...payload }),
      });
      log(`${spec.name}: ${requestId}`);
      return ok(spec.submittedMessage ?? `${spec.name} submitted; result will arrive in a follow-up message.`);
    },
  };
}

// ── Common validators ───────────────────────────────────────

function requireTweetUrl(args: Record<string, unknown>): string | null {
  if (!args.tweet_url) return 'tweet_url is required.';
  return null;
}

function requireHandle(args: Record<string, unknown>): string | null {
  if (!args.handle) return 'handle is required.';
  return null;
}

function validateLimit(args: Record<string, unknown>): string | null {
  if (args.limit !== undefined) {
    const n = args.limit as number;
    if (!Number.isInteger(n) || n < 1 || n > READ_MAX) {
      return `limit must be an integer between 1 and ${READ_MAX}.`;
    }
  }
  return null;
}

function validateTweetText(args: Record<string, unknown>, field: string, label: string): string | null {
  const text = args[field] as string | undefined;
  if (!text || text.length === 0) return `${label} cannot be empty.`;
  if (text.length > TWEET_MAX) return `${label} exceeds ${TWEET_MAX} characters (current: ${text.length}).`;
  return null;
}

function validateMedia(args: Record<string, unknown>): string | null {
  const media = args.media as string[] | undefined;
  if (!media) return null;
  if (!Array.isArray(media)) return 'media must be an array of file paths.';
  if (media.length > MEDIA_MAX) return `media: maximum ${MEDIA_MAX} images per tweet.`;
  for (const p of media) {
    if (typeof p !== 'string' || p.length === 0) return 'media entries must be non-empty file paths.';
  }
  return null;
}

function validateScheduleAt(args: Record<string, unknown>): string | null {
  const raw = args.schedule_at as string | undefined;
  if (!raw) return null;
  // Must be ISO 8601 with explicit Z or offset (no naive timestamps).
  if (!/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(raw)) {
    return 'schedule_at must be ISO 8601 with explicit timezone (e.g., 2026-05-07T09:00:00-07:00 or 2026-05-07T16:00:00Z).';
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return `schedule_at: not a valid ISO 8601 timestamp ("${raw}").`;
  if (d.getTime() < Date.now()) return 'schedule_at must be in the future.';
  return null;
}

// ── Schema fragments (re-used) ──────────────────────────────

const tweetUrlSchema = {
  type: 'string',
  description: 'Tweet URL (e.g. https://x.com/user/status/123) or raw tweet ID.',
};

const handleSchema = {
  type: 'string',
  description: 'X handle (with or without leading @).',
};

const limitSchema = {
  type: 'number',
  description: `How many items to fetch (1–${READ_MAX}, default 20).`,
  default: 20,
};

const mediaSchema = {
  type: 'array',
  items: { type: 'string' },
  description: `Optional. Up to ${MEDIA_MAX} absolute paths to image files inside the container (e.g. /workspace/agent/captures/foo.png) to attach.`,
};

const scheduleAtSchema = {
  type: 'string',
  description: 'Optional. ISO 8601 timestamp with explicit timezone (e.g. 2026-05-07T09:00:00-07:00). When present, the post is queued in X\'s native schedule rather than published immediately.',
};

// ── Read tools ──────────────────────────────────────────────

export const xReadTweet = makeXTool({
  name: 'x_read_tweet',
  description: 'Fetch a single tweet (text, author, timestamp, image alt-text, engagement counts) by URL or ID. Use this for "what do you think of this link" workflows.',
  action: 'x_read_tweet',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xReadThread = makeXTool({
  name: 'x_read_thread',
  description: 'Fetch a tweet plus its parent chain and top replies. Use this when summarizing a discussion.',
  action: 'x_read_thread',
  inputSchema: {
    type: 'object' as const,
    properties: { tweet_url: tweetUrlSchema, limit: limitSchema },
    required: ['tweet_url'],
  },
  validate: (a) => requireTweetUrl(a) ?? validateLimit(a),
  buildPayload: (args) => ({ tweetUrl: args.tweet_url, limit: args.limit ?? 20 }),
});

export const xReadUser = makeXTool({
  name: 'x_read_user',
  description: 'Fetch a user\'s recent tweets. Use this for "what has @foo been saying lately".',
  action: 'x_read_user',
  inputSchema: {
    type: 'object' as const,
    properties: { handle: handleSchema, limit: limitSchema },
    required: ['handle'],
  },
  validate: (a) => requireHandle(a) ?? validateLimit(a),
  buildPayload: (args) => ({ handle: args.handle, limit: args.limit ?? 20 }),
});

export const xReadBookmarks = makeXTool({
  name: 'x_read_bookmarks',
  description: `Read the user's bookmarked tweets, newest first. Returns up to ${BOOKMARKS_READ_MAX} per call. To walk full bookmark history, call once without cursor, then repeatedly pass the NEXT_CURSOR value from each response back as the \`cursor\` argument until the response no longer contains a NEXT_CURSOR line.`,
  action: 'x_read_bookmarks',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: `How many items to fetch (1–${BOOKMARKS_READ_MAX}, default 20). Larger batches amortize the per-call re-scroll cost when paginating.`,
        default: 20,
      },
      cursor: {
        type: 'string',
        description: 'Optional. Pagination cursor (a tweet ID) returned as NEXT_CURSOR in a previous x_read_bookmarks response. The next batch picks up immediately after this tweet.',
      },
    },
  },
  validate: (a) => {
    if (a.limit !== undefined) {
      const n = a.limit as number;
      if (!Number.isInteger(n) || n < 1 || n > BOOKMARKS_READ_MAX) {
        return `limit must be an integer between 1 and ${BOOKMARKS_READ_MAX}.`;
      }
    }
    if (a.cursor !== undefined && (typeof a.cursor !== 'string' || a.cursor.length === 0)) {
      return 'cursor must be a non-empty string (a tweet ID from a previous NEXT_CURSOR).';
    }
    return null;
  },
  buildPayload: (args) => ({
    limit: args.limit ?? 20,
    cursor: typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : null,
  }),
});

export const xReadList = makeXTool({
  name: 'x_read_list',
  description: 'Read tweets in an X list (yours or anyone\'s — pass the list URL).',
  action: 'x_read_list',
  inputSchema: {
    type: 'object' as const,
    properties: {
      list_url: { type: 'string', description: 'X list URL, e.g. https://x.com/i/lists/123456789.' },
      limit: limitSchema,
    },
    required: ['list_url'],
  },
  validate: (a) => (a.list_url ? validateLimit(a) : 'list_url is required.'),
  buildPayload: (args) => ({ listUrl: args.list_url, limit: args.limit ?? 20 }),
});

export const xReadTimeline = makeXTool({
  name: 'x_read_timeline',
  description: 'Read the user\'s home timeline (the For You / Following feed).',
  action: 'x_read_timeline',
  inputSchema: { type: 'object' as const, properties: { limit: limitSchema } },
  validate: validateLimit,
  buildPayload: (args) => ({ limit: args.limit ?? 20 }),
});

export const xReadNotifications = makeXTool({
  name: 'x_read_notifications',
  description: 'Read the user\'s mentions / interactions feed on X.',
  action: 'x_read_notifications',
  inputSchema: { type: 'object' as const, properties: { limit: limitSchema } },
  validate: validateLimit,
  buildPayload: (args) => ({ limit: args.limit ?? 20 }),
});

export const xSearch = makeXTool({
  name: 'x_search',
  description: 'Search X for tweets matching a query.',
  action: 'x_search',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query.' },
      latest: { type: 'boolean', description: 'If true, sort by Latest instead of Top. Default false.' },
      limit: limitSchema,
    },
    required: ['query'],
  },
  validate: (a) => (a.query ? validateLimit(a) : 'query is required.'),
  buildPayload: (args) => ({ query: args.query, latest: args.latest ?? false, limit: args.limit ?? 20 }),
});

// ── Compose tools (with media + schedule) ───────────────────

export const xPost = makeXTool({
  name: 'x_post',
  description: 'Post a tweet on X. Optional: attach images, schedule for later (X-native scheduling — survives even if NanoClaw is offline). Fire-and-forget; result arrives in a follow-up message.',
  action: 'x_post',
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: `Tweet text (max ${TWEET_MAX} chars).` },
      media: mediaSchema,
      schedule_at: scheduleAtSchema,
    },
    required: ['content'],
  },
  validate: (a) =>
    validateTweetText(a, 'content', 'Tweet') ?? validateMedia(a) ?? validateScheduleAt(a),
  buildPayload: (args) => ({
    content: args.content,
    media: args.media ?? [],
    scheduleAt: args.schedule_at ?? null,
  }),
});

export const xReply = makeXTool({
  name: 'x_reply',
  description: 'Reply to a tweet on X. Optional media + scheduling.',
  action: 'x_reply',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tweet_url: tweetUrlSchema,
      content: { type: 'string', description: `Reply text (max ${TWEET_MAX} chars).` },
      media: mediaSchema,
      schedule_at: scheduleAtSchema,
    },
    required: ['tweet_url', 'content'],
  },
  validate: (a) =>
    requireTweetUrl(a) ??
    validateTweetText(a, 'content', 'Reply') ??
    validateMedia(a) ??
    validateScheduleAt(a),
  buildPayload: (args) => ({
    tweetUrl: args.tweet_url,
    content: args.content,
    media: args.media ?? [],
    scheduleAt: args.schedule_at ?? null,
  }),
});

export const xQuote = makeXTool({
  name: 'x_quote',
  description: 'Quote-tweet on X with your own comment. Optional media + scheduling.',
  action: 'x_quote',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tweet_url: tweetUrlSchema,
      comment: { type: 'string', description: `Quote comment (max ${TWEET_MAX} chars).` },
      media: mediaSchema,
      schedule_at: scheduleAtSchema,
    },
    required: ['tweet_url', 'comment'],
  },
  validate: (a) =>
    requireTweetUrl(a) ??
    validateTweetText(a, 'comment', 'Quote comment') ??
    validateMedia(a) ??
    validateScheduleAt(a),
  buildPayload: (args) => ({
    tweetUrl: args.tweet_url,
    comment: args.comment,
    media: args.media ?? [],
    scheduleAt: args.schedule_at ?? null,
  }),
});

// ── Engagement toggles ──────────────────────────────────────

export const xLike = makeXTool({
  name: 'x_like',
  description: 'Like a tweet on X.',
  action: 'x_like',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xUnlike = makeXTool({
  name: 'x_unlike',
  description: 'Remove your like from a tweet on X.',
  action: 'x_unlike',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xRetweet = makeXTool({
  name: 'x_retweet',
  description: 'Retweet a tweet on X (no comment).',
  action: 'x_retweet',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xUnretweet = makeXTool({
  name: 'x_unretweet',
  description: 'Undo your retweet of a tweet on X.',
  action: 'x_unretweet',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xBookmark = makeXTool({
  name: 'x_bookmark',
  description: 'Bookmark a tweet on X.',
  action: 'x_bookmark',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xUnbookmark = makeXTool({
  name: 'x_unbookmark',
  description: 'Remove a bookmark on X.',
  action: 'x_unbookmark',
  inputSchema: { type: 'object' as const, properties: { tweet_url: tweetUrlSchema }, required: ['tweet_url'] },
  validate: requireTweetUrl,
  buildPayload: (args) => ({ tweetUrl: args.tweet_url }),
});

export const xFollow = makeXTool({
  name: 'x_follow',
  description: 'Follow a user on X.',
  action: 'x_follow',
  inputSchema: { type: 'object' as const, properties: { handle: handleSchema }, required: ['handle'] },
  validate: requireHandle,
  buildPayload: (args) => ({ handle: args.handle }),
});

export const xUnfollow = makeXTool({
  name: 'x_unfollow',
  description: 'Unfollow a user on X.',
  action: 'x_unfollow',
  inputSchema: { type: 'object' as const, properties: { handle: handleSchema }, required: ['handle'] },
  validate: requireHandle,
  buildPayload: (args) => ({ handle: args.handle }),
});

export const xDeleteTweet = makeXTool({
  name: 'x_delete_tweet',
  description:
    'Irreversibly delete one of your own tweets on X. ' +
    'REQUIRES text_must_match — a distinctive substring (≥5 chars) of the tweet body. ' +
    'The host script reads the live tweet first and refuses to delete unless the substring is present. ' +
    'This guards against URL hallucinations and copy-paste errors. ' +
    'Always read the tweet (x_read_tweet) before calling delete, and pass back a phrase from it as text_must_match.',
  action: 'x_delete_tweet',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tweet_url: tweetUrlSchema,
      text_must_match: {
        type: 'string',
        description:
          'A distinctive substring (≥5 chars) of the tweet body. Safety guard — script will refuse to delete if not present.',
        minLength: 5,
      },
    },
    required: ['tweet_url', 'text_must_match'],
  },
  validate: (args) => {
    const url = requireTweetUrl(args);
    if (url) return url;
    const m = args.text_must_match;
    if (typeof m !== 'string' || m.trim().length < 5) {
      return 'text_must_match must be a string of at least 5 non-whitespace characters from the tweet body.';
    }
    return null;
  },
  buildPayload: (args) => ({ tweetUrl: args.tweet_url, textMustMatch: args.text_must_match }),
});

// ── Scheduling ──────────────────────────────────────────────

export const xListScheduled = makeXTool({
  name: 'x_list_scheduled',
  description: 'List your pending scheduled tweets on X.',
  action: 'x_list_scheduled',
  inputSchema: { type: 'object' as const, properties: {} },
});

export const xCancelScheduled = makeXTool({
  name: 'x_cancel_scheduled',
  description: 'Cancel a scheduled tweet from X\'s queue. Pass the index from x_list_scheduled (1-based) or a substring of the tweet text.',
  action: 'x_cancel_scheduled',
  inputSchema: {
    type: 'object' as const,
    properties: {
      index: { type: 'number', description: '1-based index from x_list_scheduled output.' },
      text_match: { type: 'string', description: 'Substring of the scheduled tweet text. Use if you don\'t have the index.' },
    },
  },
  validate: (a) => {
    if (a.index === undefined && !a.text_match) {
      return 'Pass either index (from x_list_scheduled) or text_match.';
    }
    return null;
  },
  buildPayload: (args) => ({ index: args.index ?? null, textMatch: args.text_match ?? null }),
});

// ── DMs ─────────────────────────────────────────────────────

export const xReadDmInbox = makeXTool({
  name: 'x_read_dm_inbox',
  description: 'Read the user\'s DM inbox — list of conversations with unread state and last-message preview. Does not mark anything read.',
  action: 'x_read_dm_inbox',
  inputSchema: { type: 'object' as const, properties: { limit: limitSchema } },
  validate: validateLimit,
  buildPayload: (args) => ({ limit: args.limit ?? 20 }),
});

export const xReadDmThread = makeXTool({
  name: 'x_read_dm_thread',
  description: 'Read messages in a single DM conversation by recipient handle. CAVEAT: opening the thread marks unread messages as read on X — this is unavoidable. Don\'t call this casually on threads with unread context the user wants to see fresh.',
  action: 'x_read_dm_thread',
  inputSchema: {
    type: 'object' as const,
    properties: { handle: handleSchema, limit: limitSchema },
    required: ['handle'],
  },
  validate: (a) => requireHandle(a) ?? validateLimit(a),
  buildPayload: (args) => ({ handle: args.handle, limit: args.limit ?? 30 }),
});

export const xSendDm = makeXTool({
  name: 'x_send_dm',
  description: 'Send a direct message to a single user on X by handle.',
  action: 'x_send_dm',
  inputSchema: {
    type: 'object' as const,
    properties: {
      handle: handleSchema,
      content: { type: 'string', description: `Message body (max ${DM_MAX} chars).` },
    },
    required: ['handle', 'content'],
  },
  validate: (a) => {
    if (!a.handle) return 'handle is required.';
    const text = a.content as string | undefined;
    if (!text || text.length === 0) return 'content cannot be empty.';
    if (text.length > DM_MAX) return `content exceeds ${DM_MAX} characters (current: ${text.length}).`;
    return null;
  },
  buildPayload: (args) => ({ handle: args.handle, content: args.content }),
});

// ── Bulk export ─────────────────────────────────────────────

export const xExportBookmarks = makeXTool({
  name: 'x_export_bookmarks',
  description: `Export all of the user's bookmarks to a CSV file at /workspace/group/captures/bookmarks.csv. Resumable: each call scrolls for ~75 seconds, appends new rows, and saves a progress sidecar. For users with thousands of bookmarks, call repeatedly until the response says "End of bookmarks reached." Pass reset=true to start over (truncates the CSV). After export completes, read or analyze the CSV with normal file tools.`,
  action: 'x_export_bookmarks',
  inputSchema: {
    type: 'object' as const,
    properties: {
      reset: {
        type: 'boolean',
        description: 'If true, delete the existing CSV + progress sidecar and start fresh. Default false (resume from where the last call stopped).',
        default: false,
      },
    },
  },
  validate: (a) => {
    if (a.reset !== undefined && typeof a.reset !== 'boolean') {
      return 'reset must be a boolean.';
    }
    return null;
  },
  buildPayload: (args) => ({ reset: args.reset === true }),
});

// ── Register all tools ──────────────────────────────────────

registerTools([
  xReadTweet, xReadThread, xReadUser, xReadBookmarks, xReadList,
  xReadTimeline, xReadNotifications, xSearch,
  xPost, xReply, xQuote,
  xLike, xUnlike, xRetweet, xUnretweet, xBookmark, xUnbookmark, xFollow, xUnfollow,
  xDeleteTweet,
  xListScheduled, xCancelScheduled,
  xReadDmInbox, xReadDmThread, xSendDm,
  xExportBookmarks,
]);
