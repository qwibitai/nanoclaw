/**
 * Outbound `@DisplayName` → `<@USERID>` resolution for Discord.
 *
 * Discord's mention syntax is `<@123456789>` (the numeric snowflake), not
 * `<@SomeName>` — but the chat-sdk Discord adapter (index.js:250 +
 * index.js:296) blindly wraps `@(\w+)` → `<@$1>` for both plain-string
 * and AST-rendered messages, producing `<@RYU>` which Discord renders as
 * literal text rather than a real ping. 1.x's hand-rolled discord.ts
 * matched display-name mentions back to user snowflakes via a
 * `mentionCache` populated from inbound messages
 * (see _legacy/v1.2.49/src/channels/discord.ts:90 +
 * resolveOutboundMentions). This module ports that approach.
 *
 * Cache is a per-process Map<lowercased-name, userId>. Populated on every
 * inbound author seen via the bridge's `recordInboundAuthor` hook;
 * outbound text rewrites with longest-match-first so "Sean Bonner"
 * matches before "Sean".
 *
 * No identity-index file integration today — the global identity-index
 * has no Discord entries (verified 2026-05-06: 1894 entries, 0 with
 * `discord:` prefix). If that changes, mirror slack-mentions.ts and
 * load lazily from disk.
 */

const cache = new Map<string, string>(); // lowercased-name → userId

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Unwrap redundant markdown links of the form `[X](X)` to bare `X`. Discord
 * does not render these — its parser trips on the brackets when the label
 * is itself a URL, so `[https://opensea.io/...](https://opensea.io/...)`
 * shows as literal text instead of a clickable link. Bare URLs auto-link
 * fine on Discord, so dropping the wrapper is the right move. Genuine
 * `[label](url)` links (label !== url) pass through unchanged.
 */
export function unwrapRedundantMarkdownLinks(text: string): string {
  if (!text || !text.includes('](')) return text;
  return text.replace(MD_LINK_RE, (match, label, url) => (label === url ? label : match));
}

/**
 * Record an inbound author. Called by the chat-sdk bridge whenever it
 * forwards an inbound message. Cheap enough to call unconditionally per
 * message — Map.set on a duplicate is a no-op.
 *
 * Both fullName and userName are checked because Discord users have
 * `global_name` (display name) and `username` (the @handle) — agents may
 * use either when writing replies.
 */
export function recordDiscordIdentity(userId: string | undefined, fullName?: string, userName?: string): void {
  if (!userId) return;
  for (const candidate of [fullName, userName]) {
    if (!candidate) continue;
    const key = candidate.toLowerCase().trim();
    if (key && !cache.has(key)) cache.set(key, userId);
  }
}

/** Test-only: clear the cache. */
export function resetDiscordMentionsCache(): void {
  cache.clear();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite `@DisplayName` to `<@USERID>` for any name found in the cache.
 * Falls through unchanged when the cache has no match for a token. The
 * chat-sdk's own `convertMentionsToDiscord` is patched out by the caller
 * (see discord.ts) so this is the sole path that produces Discord
 * mention syntax on outbound.
 */
export function compactDiscordMentions(text: string): string {
  if (!text || !text.includes('@') || cache.size === 0) return text;

  // Longest-first so multi-word names match before their first-name
  // prefix.
  const sorted = [...cache.entries()].sort((a, b) => b[0].length - a[0].length);

  let result = text;
  for (const [name, userId] of sorted) {
    // Match @name as a token: requires word-boundary or end-of-string
    // after, so "@Sean" inside "@SeanBonner" doesn't get mangled when
    // both "Sean" and "Sean Bonner" are in the cache.
    const re = new RegExp(`@${escapeRegex(name)}(?=$|[^\\w-])`, 'gi');
    result = result.replace(re, `<@${userId}>`);
  }
  return result;
}
