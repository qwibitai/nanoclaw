/**
 * DOM-extraction primitives for X read scripts.
 *
 * Every read tool that returns tweet/user/DM data routes through here.
 * When X changes a DOM structure, fix it once and all 8 read tools pick
 * up the change.
 *
 * Selectors live in lib/locators.ts. This file holds the *parsing* logic
 * — converting Playwright Locators into typed JS objects. Two layers
 * makes it cheap to swap a selector without re-deriving extraction.
 */

import type { Locator, Page } from 'playwright-core';
import { X_SELECTORS } from './locators.js';

// ── Types ────────────────────────────────────────────────────

export interface ParsedTweet {
  id: string;
  url: string;
  authorHandle: string;
  authorName: string;
  text: string;
  timestamp: string;
  imageAltTexts: string[];
  metrics: { likes: number; retweets: number; replies: number; bookmarks?: number };
  isReply: boolean;
  isRetweet: boolean;
}

export interface ParsedDmMessage {
  text: string;
  /** ISO timestamp if extractable, else null. */
  timestamp: string | null;
  /** "you" if sent by the logged-in user, else "them". */
  direction: 'you' | 'them';
}

export interface ParsedDmConversation {
  /** Conversation handle (the other party's @handle, no leading @). */
  handle: string;
  displayName: string;
  /** Last message preview text. */
  preview: string;
  unread: boolean;
  /** Timestamp string as rendered (X uses relative — "2h", "Apr 3" — leave as-is). */
  timeLabel: string;
}

// ── Helpers ──────────────────────────────────────────────────

/** Parse "1.2K" / "5,432" / "12" into a number. */
function parseMetric(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g, '').trim();
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])$/i);
  if (match) {
    const n = parseFloat(match[1]);
    const mult = match[2].toUpperCase() === 'K' ? 1e3 : match[2].toUpperCase() === 'M' ? 1e6 : 1e9;
    return Math.round(n * mult);
  }
  return 0;
}

/** Extract tweet ID + author handle from a status URL. */
function parseStatusUrl(url: string): { handle: string; tweetId: string } | null {
  const m = url.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\/(\d+)/);
  if (!m) return null;
  return { handle: m[1], tweetId: m[2] };
}

// ── Tweet card parsing ───────────────────────────────────────

/**
 * Parse a single tweet article. Tolerant — missing pieces become empty
 * strings or zero rather than throwing, so a partially-rendered card
 * still yields a usable record.
 */
export async function parseTweetCard(article: Locator): Promise<ParsedTweet> {
  // Permalink + ID via the timestamp anchor
  let url = '';
  let id = '';
  let handle = '';
  let timestamp = '';
  try {
    const timeEl = article.locator(X_SELECTORS.tweetTime).first();
    if (await timeEl.count()) {
      timestamp = (await timeEl.getAttribute('datetime')) || '';
      const anchor = timeEl.locator('xpath=ancestor::a').first();
      if (await anchor.count()) {
        const href = (await anchor.getAttribute('href')) || '';
        url = href.startsWith('http') ? href : `https://x.com${href}`;
        const parsed = parseStatusUrl(url);
        if (parsed) {
          id = parsed.tweetId;
          handle = parsed.handle;
        }
      }
    }
  } catch {}

  // Author display name
  let authorName = '';
  try {
    const nameEl = article.locator(X_SELECTORS.tweetUserName).first();
    if (await nameEl.count()) {
      authorName = ((await nameEl.innerText()) || '').split('\n')[0].trim();
    }
  } catch {}
  if (!handle) {
    // Fallback: pluck handle from the User-Name block
    try {
      const nameEl = article.locator(X_SELECTORS.tweetUserName).first();
      const txt = (await nameEl.innerText()) || '';
      const m = txt.match(/@([\w]+)/);
      if (m) handle = m[1];
    } catch {}
  }

  // Tweet text (may be empty for media-only posts)
  let text = '';
  try {
    const textEl = article.locator(X_SELECTORS.tweetText).first();
    if (await textEl.count()) {
      text = ((await textEl.innerText()) || '').trim();
    }
  } catch {}

  // Image alt-text (the agent uses these for vision-without-vision)
  const imageAltTexts: string[] = [];
  try {
    const imgs = article.locator(X_SELECTORS.tweetImage);
    const count = await imgs.count();
    for (let i = 0; i < count; i++) {
      const alt = await imgs.nth(i).getAttribute('alt');
      if (alt && alt !== 'Image') imageAltTexts.push(alt);
    }
  } catch {}

  // Engagement metrics — read aria-labels off the action buttons
  const metrics = { likes: 0, retweets: 0, replies: 0, bookmarks: undefined as number | undefined };
  for (const [key, sel] of [
    ['likes', X_SELECTORS.like],
    ['likes', X_SELECTORS.unlike],
    ['retweets', X_SELECTORS.retweet],
    ['retweets', X_SELECTORS.unretweet],
    ['replies', X_SELECTORS.reply],
  ] as const) {
    try {
      const btn = article.locator(sel).first();
      if (!(await btn.count())) continue;
      const label = (await btn.getAttribute('aria-label')) || '';
      const match = label.match(/([\d,.]+\s*[KMB]?)/);
      if (match) {
        const n = parseMetric(match[1]);
        if (n > 0) metrics[key] = n;
      }
    } catch {}
  }

  // Heuristic flags
  const lowerHtml = (await article.innerHTML().catch(() => '')).toLowerCase();
  const isReply = lowerHtml.includes('replying to');
  const isRetweet = lowerHtml.includes('reposted');

  return {
    id,
    url,
    authorHandle: handle,
    authorName,
    text,
    timestamp,
    imageAltTexts,
    metrics,
    isReply,
    isRetweet,
  };
}

/**
 * Scroll-and-collect: scrape up to `limit` tweets from a feed. Each scroll
 * waits for new articles to attach before parsing. De-dupes by tweet ID.
 *
 * `skipUntilId` enables pseudo-cursor pagination on infinite-scroll feeds
 * (X's bookmarks / search / timeline have no native cursor in the DOM).
 * When set, the scroll-and-parse loop runs in a "fast-forward" phase that
 * marks tweets as seen without adding them to the result; collection
 * begins on the round AFTER the marker tweet appears in the DOM. This
 * lets the caller walk an infinite feed in batches by passing back the
 * last tweet ID from the previous batch. Cost: each paginated call
 * re-scrolls everything up to the marker before collecting fresh items,
 * so deeper walks are progressively slower.
 */
export async function collectTweets(
  page: Page,
  limit: number,
  options: { scrollMaxRounds?: number; scrollPauseMs?: number; skipUntilId?: string } = {},
): Promise<ParsedTweet[]> {
  const maxRounds = options.scrollMaxRounds ?? 30;
  const pauseMs = options.scrollPauseMs ?? 800;
  const skipUntilId = options.skipUntilId;
  const seen = new Set<string>();
  const tweets: ParsedTweet[] = [];
  let pastMarker = !skipUntilId;

  for (let round = 0; round < maxRounds && tweets.length < limit; round++) {
    const articles = page.locator(X_SELECTORS.tweet);
    const count = await articles.count();
    for (let i = 0; i < count && tweets.length < limit; i++) {
      const parsed = await parseTweetCard(articles.nth(i));
      if (!parsed.id || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      if (!pastMarker) {
        if (parsed.id === skipUntilId) pastMarker = true;
        continue;
      }
      tweets.push(parsed);
    }
    if (tweets.length >= limit) break;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(pauseMs);
  }

  return tweets;
}

// ── Pretty-print for notifyAgent ─────────────────────────────

export function renderTweet(t: ParsedTweet): string {
  const head = `${t.authorName || '?'} (@${t.authorHandle || '?'})${t.timestamp ? ` · ${t.timestamp}` : ''}`;
  const body = t.text || '(no text — media or quote-only)';
  const meta = `❤ ${t.metrics.likes}  🔁 ${t.metrics.retweets}  💬 ${t.metrics.replies}`;
  const alt = t.imageAltTexts.length ? `\nImages: ${t.imageAltTexts.map((a) => `"${a}"`).join(', ')}` : '';
  const link = t.url ? `\n${t.url}` : '';
  return `${head}\n${body}\n${meta}${alt}${link}`;
}

export function renderTweetList(tweets: ParsedTweet[], header?: string): string {
  if (tweets.length === 0) return `${header ?? 'No tweets found.'}\n(0 results)`;
  const blocks = tweets.map((t, i) => `[${i + 1}] ${renderTweet(t)}`);
  return `${header ?? `${tweets.length} tweet${tweets.length === 1 ? '' : 's'}:`}\n\n${blocks.join('\n\n---\n\n')}`;
}

// ── DM parsing ───────────────────────────────────────────────

export async function parseDmConversation(row: Locator): Promise<ParsedDmConversation> {
  let handle = '';
  let displayName = '';
  let preview = '';
  let unread = false;
  let timeLabel = '';

  try {
    const txt = ((await row.innerText()) || '').trim();
    // Inbox row format (typical): "Display Name\n@handle · 2h\nPreview text..."
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines[0]) displayName = lines[0];
    if (lines[1]) {
      const m = lines[1].match(/@([\w]+)(?:\s*·\s*(.+))?/);
      if (m) {
        handle = m[1];
        timeLabel = m[2] || '';
      }
    }
    if (lines[2]) preview = lines[2];
    // Heuristic: unread rows have an unread indicator dot — try multiple paths
    const dot = await row.locator('[aria-label*="unread" i], [data-testid="unreadDot"]').count().catch(() => 0);
    unread = dot > 0;
  } catch {}

  return { handle, displayName, preview, unread, timeLabel };
}

export function renderDmInbox(conversations: ParsedDmConversation[]): string {
  if (conversations.length === 0) return 'DM inbox is empty.';
  const blocks = conversations.map((c, i) => {
    const head = `[${i + 1}] ${c.displayName} (@${c.handle})${c.unread ? ' · UNREAD' : ''}${c.timeLabel ? ` · ${c.timeLabel}` : ''}`;
    return `${head}\n${c.preview}`;
  });
  return `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}:\n\n${blocks.join('\n\n---\n\n')}`;
}

export function renderDmThread(messages: ParsedDmMessage[], handle: string): string {
  if (messages.length === 0) return `No messages found in DM thread with @${handle}.`;
  const blocks = messages.map((m) => {
    const who = m.direction === 'you' ? 'YOU' : `@${handle}`;
    const time = m.timestamp ? ` (${m.timestamp})` : '';
    return `${who}${time}: ${m.text}`;
  });
  return `DM thread with @${handle} (${messages.length} message${messages.length === 1 ? '' : 's'}):\n\n${blocks.join('\n')}`;
}
