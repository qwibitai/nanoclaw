/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Constants, MessageType, REST, Routes } from 'discord.js';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Fetch the parent/anchor message that seeded a Discord thread.
 *
 * The Chat SDK encodes thread ids as `discord:{guildId}:{channelId}:{threadId}`
 * where `channelId` is the parent channel and `threadId` (when present) is the
 * Discord thread id. For threads created from a message (the common case for
 * "Reply" auto-thread or right-click → Create Thread), the thread id equals
 * the parent message id, and that message lives in the parent channel — not
 * inside the thread. So `GET /channels/{thread_id}/messages` (what
 * `fetchMessages` calls) skips the anchor entirely.
 *
 * Without this lookup the agent's first wake inside an auto-thread sees only
 * the user's reply, with no idea what they're replying to.
 *
 * Returns null for channel-root messages (no thread part), forum-style
 * threads where the anchor is already the first in-thread message (404), or
 * any error — callers fall through to the normal in-thread history.
 */
interface DiscordRawMessage {
  content?: string;
  timestamp?: string;
  author?: { global_name?: string; username?: string };
  referenced_message?: DiscordRawMessage | null;
}

function parseAnchorMessage(
  msg: DiscordRawMessage,
): { sender: string; text: string; timestamp: string; isAnchor: true } | null {
  const text = msg.content ?? '';
  if (!text) return null;
  const sender = msg.author?.global_name || msg.author?.username || 'unknown';
  const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  return { sender, text, timestamp, isAnchor: true };
}

function makeFetchThreadAnchor(
  botToken: string,
): (
  encodedThreadId: string,
  opts?: { excludeMessageId?: string },
) => Promise<Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> | null> {
  return async (encodedThreadId, opts) => {
    const parts = encodedThreadId.split(':');
    if (parts.length < 4 || parts[0] !== 'discord') return null;
    const channelId = parts[2];
    const threadId = parts[3];
    if (!channelId || !threadId) return null;

    // Discord's chat-adapter auto-creates a thread anchored on the user's
    // @mention message — `thread.id == mention.id`. On the first wake the
    // trigger IS the anchor, so the hook bails out: prepending it would
    // duplicate the current turn into the prepended thread context.
    if (opts?.excludeMessageId && opts.excludeMessageId === threadId) return null;

    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${threadId}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    } catch (err) {
      log.debug('Discord anchor fetch network error', {
        encodedThreadId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      log.debug('Discord anchor fetch non-OK', { encodedThreadId, status: response.status });
      return null;
    }
    const m1 = (await response.json()) as DiscordRawMessage;

    // M0: the message M1 was Reply-ing to. Discord inlines `referenced_message`
    // on the GET response when the parent is recent enough (~2 weeks), so no
    // second round-trip is needed. This is the message the user actually
    // wants the agent to act on — the anchor (M1) by itself is often a bare
    // imperative like "fix this" that's meaningless without M0.
    const out: Array<{ sender: string; text: string; timestamp: string; isAnchor: true }> = [];
    const m0 = m1.referenced_message ? parseAnchorMessage(m1.referenced_message) : null;
    if (m0) out.push(m0);
    const m1Parsed = parseAnchorMessage(m1);
    if (m1Parsed) out.push(m1Parsed);
    return out.length > 0 ? out : null;
  };
}

/**
 * Mirror discord.js's `message.system` semantics: keep DEFAULT, REPLY,
 * CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND; drop everything else.
 *
 * THREAD_STARTER_MESSAGE (the synthetic echo Discord inserts inside an
 * auto-thread) would otherwise route the parent's content twice — once at
 * the parent and again when the bridge sees the starter — so it stays
 * filtered even though it carries user-authored text.
 */
const NON_SYSTEM_TYPES = new Set<number>(Constants.NonSystemMessageTypes);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isUserMessage(message: { raw?: any }): boolean {
  const type = message.raw?.type as MessageType | undefined;
  if (type === undefined) return true;
  return NON_SYSTEM_TYPES.has(type);
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const BARE_URL_PATTERN = new RegExp(String.raw`https?:\/\/[^\s<>()\[\]]+`, 'g');
const URL_SHAPED_TEXT_PATTERN = /https?:\/\//;

function discordSafeLinkLabel(url: string): string {
  if (!URL.canParse(url)) return 'Open link';

  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'docs.google.com') {
    if (parsed.pathname.startsWith('/document/')) return 'Open Google Doc';
    if (parsed.pathname.startsWith('/presentation/')) return 'Open Google Slides';
    if (parsed.pathname.startsWith('/spreadsheets/')) return 'Open Google Sheet';
    return 'Open Google file';
  }
  return 'Open link';
}

function safeDiscordLink(url: string): string {
  return `[${discordSafeLinkLabel(url)}](${url})`;
}

function rewriteBareDiscordUrl(urlWithPossiblePunctuation: string): string {
  const trailing = /[.,!?;:]+$/.exec(urlWithPossiblePunctuation)?.[0] ?? '';
  const url = trailing ? urlWithPossiblePunctuation.slice(0, -trailing.length) : urlWithPossiblePunctuation;
  return `${safeDiscordLink(url)}${trailing}`;
}

/**
 * Rewrite URL-shaped links into labels Discord will render.
 *
 * The Discord Chat SDK adapter parses GFM autolinks, then renders every link
 * node as `[label](url)`. For bare URLs, that makes `label === url`, and
 * Discord's anti-phishing filter leaves the literal `[url](url)` text visible.
 * Descriptive masked links render correctly and are left alone.
 *
 * Code regions are protected so URLs inside fenced/inline code stay literal.
 */
export function rewriteDiscordLinks(text: string): string {
  return transformOutsideProtectedRegions(text, (segment) => {
    const protectedLinks: string[] = [];
    const withoutMarkdownLinks = segment.replace(MARKDOWN_LINK_PATTERN, (match, linkText: string, url: string) => {
      const replacement = URL_SHAPED_TEXT_PATTERN.test(linkText) ? safeDiscordLink(url) : match;
      const token = `DISCORD_LINK_PLACEHOLDER_${protectedLinks.length}`;
      protectedLinks.push(replacement);
      return token;
    });

    const withoutBareUrls = withoutMarkdownLinks.replace(BARE_URL_PATTERN, rewriteBareDiscordUrl);
    return withoutBareUrls.replace(
      /DISCORD_LINK_PLACEHOLDER_(\d+)/g,
      (match, index: string) => protectedLinks[Number(index)] ?? match,
    );
  });
}

/** Minimal REST interface for Discord operations — narrow surface for testing. */
export interface DiscordRestClient {
  post(route: `/${string}`, options?: { body?: unknown }): Promise<unknown>;
}

/**
 * Strip the `discord:` scheme prefix and leading `guildId:` segment from a
 * NanoClaw platform_id, leaving the raw Discord channel ID that the REST API
 * expects. Tolerates `discord:guildId:channelId`, `discord:guildId:channelId:threadId`,
 * and bare `channelId` (test inputs). The host's regular delivery path
 * normalizes via the chat-sdk bridge — these helpers are called from
 * orchestrator-dispatch directly and need to do their own normalization or
 * the REST call hits `/channels/discord:.../messages` and returns 404.
 */
export function extractDiscordChannelId(platformId: string): string {
  if (!platformId.startsWith('discord:')) return platformId;
  const parts = platformId.split(':');
  // discord:{guildId}:{channelId}[:{threadId}] — the channel id we want is index 2
  return parts[2] ?? platformId;
}

/**
 * Post a message to the top level of a Discord channel.
 * Exported for unit testing.
 */
export async function discordPostParent(
  rest: DiscordRestClient,
  platformId: string,
  text: string,
): Promise<{ messageId: string }> {
  const channelId = extractDiscordChannelId(platformId);
  const msg = (await rest.post(Routes.channelMessages(channelId), {
    body: { content: text },
  })) as { id: string };
  return { messageId: msg.id };
}

/**
 * Create a Discord thread from a parent message and post the first message.
 * Exported for unit testing.
 */
export async function discordCreateThread(
  rest: DiscordRestClient,
  platformId: string,
  parentMessageId: string,
  title: string,
  firstMessage: string,
): Promise<{ threadId: string; messageId: string }> {
  const channelId = extractDiscordChannelId(platformId);
  const thread = (await rest.post(Routes.threads(channelId, parentMessageId), {
    body: { name: title },
  })) as { id: string };
  const firstMsg = (await rest.post(Routes.channelMessages(thread.id), {
    body: { content: firstMessage },
  })) as { id: string };
  return { threadId: thread.id, messageId: firstMsg.id };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: 1900,
      // Markdown delivery (not raw) keeps the chat-adapter's tableToAscii
      // conversion in play; without it, Markdown tables would render as raw
      // `|`-pipe text in Discord (no native table block).
      transformOutboundMarkdown: rewriteDiscordLinks,
      inboundFilter: isUserMessage,
      fetchThreadAnchor: makeFetchThreadAnchor(env.DISCORD_BOT_TOKEN),
    });
    bridge.postParent = (platformId, text) => discordPostParent(rest, platformId, text);
    bridge.createThread = (platformId, parentMessageId, title, firstMessage) =>
      discordCreateThread(rest, platformId, parentMessageId, title, firstMessage);
    return bridge;
  },
});
