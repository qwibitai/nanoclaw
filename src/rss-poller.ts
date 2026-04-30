import { XMLParser } from 'fast-xml-parser';

import { getSeenItemIds, markItemSeen } from './db.js';
import { logger } from './logger.js';
import { readRssConfig, type RssChannelConfig } from './rss-config.js';

const DEFAULT_RSS_POLL_INTERVAL = 15 * 60 * 1000;
const RSS_BURST_SEND_DELAY_MS = 1000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
});

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string; '@_isPermaLink'?: string };
  id?: string;
  pubDate?: string;
  description?: string;
}

function extractGuid(item: RssItem, feedUrl: string): string {
  if (item.guid) {
    const text =
      typeof item.guid === 'object'
        ? String(item.guid['#text'] ?? '').trim()
        : String(item.guid).trim();
    if (text) return text;
  }
  if (item.id) return item.id;
  if (item.link) return item.link;
  return `${feedUrl}#${item.title || 'untitled'}`;
}

function parseTime(d?: string): number {
  if (!d) return Infinity;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

function sortByPubDate(
  items: Array<{ item: RssItem; guid: string }>,
): Array<{ item: RssItem; guid: string }> {
  // Reverse before sorting so that equal-pubDate ties break in feed order
  // (most feeds are newest-first, so reversed = oldest-first for ties).
  // JS sort is stable (ES2019+). Items without pubDate sort to the end via Infinity.
  return [...items]
    .reverse()
    .sort((a, b) => parseTime(a.item.pubDate) - parseTime(b.item.pubDate));
}

async function fetchFeed(
  feedUrl: string,
  feedName?: string,
): Promise<Array<{ item: RssItem; guid: string }>> {
  const label = feedName || feedUrl;
  try {
    const response = await fetch(feedUrl, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'nanoclaw-rss/1.0' },
    });

    if (!response.ok) {
      logger.warn(
        { feedUrl, status: response.status },
        `RSS feed "${label}" returned HTTP ${response.status}`,
      );
      return [];
    }

    const xml = await response.text();
    const parsed = xmlParser.parse(xml);

    const rss = parsed.rss || parsed['rdf:RDF'] || parsed.RDF || parsed.feed;
    if (!rss) {
      logger.warn({ feedUrl }, `RSS feed "${label}" has unrecognizable format`);
      return [];
    }

    const channel = rss.channel || rss;
    let items: RssItem[] =
      channel.item || rss.item || channel.entry || rss.entry || [];

    if (!Array.isArray(items)) {
      items = [items];
    }

    return items.map((item: RssItem) => ({
      item,
      guid: extractGuid(item, feedUrl),
    }));
  } catch (err) {
    logger.warn({ feedUrl, err }, `RSS feed "${label}" fetch failed`);
    return [];
  }
}

export interface RssPollerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, unknown>;
  getConfig?: () => RssChannelConfig[];
  burstDelayMs?: number;
}

interface PollerInstance {
  running: boolean;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let activePoller: PollerInstance | null = null;

export async function pollOnce(deps: RssPollerDeps): Promise<void> {
  const config = deps.getConfig ? deps.getConfig() : readRssConfig();
  if (config.length === 0) return;

  const groups = deps.registeredGroups();

  for (const channelConfig of config) {
    if (!(channelConfig.jid in groups)) {
      logger.debug(
        { jid: channelConfig.jid },
        'RSS: skipping unregistered channel',
      );
      continue;
    }

    const feedResults = await Promise.all(
      channelConfig.feeds.map((feed) =>
        fetchFeed(feed.url, feed.name).then((items) => ({ feed, items })),
      ),
    );

    for (const { feed, items } of feedResults) {
      const seenIds = getSeenItemIds(
        feed.url,
        items.map((e) => e.guid),
      );
      const newItems = items.filter((entry) => !seenIds.has(entry.guid));
      const sorted = sortByPubDate(newItems);

      for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        const label = feed.name || feed.url;
        const title = entry.item.title?.trim() || '(no title)';
        const link = entry.item.link?.trim() || '';
        const text = link
          ? `📰 **${label}**: ${title}\n${link}`
          : `📰 **${label}**: ${title}`;

        try {
          await deps.sendMessage(channelConfig.jid, text);
          markItemSeen(feed.url, entry.guid);
        } catch (err) {
          // markItemSeen は送信成功後のみ呼ぶ。失敗した記事は次回ポーリングで再送する。
          logger.error(
            { err, jid: channelConfig.jid, guid: entry.guid },
            'Failed to send RSS message',
          );
        }

        // Avoid Discord rate limits on burst sends during first startup
        if (i < sorted.length - 1) {
          const delay = deps.burstDelayMs ?? RSS_BURST_SEND_DELAY_MS;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
}

export interface StartRssPollerOptions {
  intervalMs?: number;
}

export function startRssPoller(
  deps: RssPollerDeps,
  options?: StartRssPollerOptions,
): void {
  const intervalMs = options?.intervalMs ?? DEFAULT_RSS_POLL_INTERVAL;

  if (activePoller?.running) {
    logger.debug('RSS poller already running, skipping duplicate start');
    return;
  }

  const poller: PollerInstance = {
    running: true,
    intervalMs,
    timer: null,
  };
  activePoller = poller;

  const intervalMinutes = Math.round(intervalMs / 60000);
  logger.info(
    { intervalMs },
    `RSS poller started (${intervalMinutes}-minute interval)`,
  );

  const loop = async () => {
    if (!poller.running) return;
    try {
      await pollOnce(deps);
    } catch (err) {
      logger.error({ err }, 'Error in RSS poller loop');
    }
    if (poller.running) {
      poller.timer = setTimeout(loop, intervalMs);
    }
  };

  loop();
}

/** @internal - テスト用のみ。 */
export function _resetRssPollerForTests(): void {
  if (activePoller) {
    activePoller.running = false;
    if (activePoller.timer) {
      clearTimeout(activePoller.timer);
    }
    activePoller = null;
  }
}
