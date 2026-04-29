import { XMLParser } from 'fast-xml-parser';

import { hasSeenItem, markItemSeen } from './db.js';
import { logger } from './logger.js';
import { readRssConfig, type RssChannelConfig } from './rss-config.js';

const RSS_POLL_INTERVAL = 15 * 60 * 1000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string; '@_isPermaLink'?: string };
  pubDate?: string;
  description?: string;
}

function extractGuid(item: RssItem, feedUrl: string): string {
  if (item.guid) {
    if (typeof item.guid === 'object' && item.guid['#text']) {
      return String(item.guid['#text']);
    }
    return String(item.guid);
  }
  return item.link || feedUrl;
}

function sortByPubDate(items: Array<{ item: RssItem; guid: string }>): Array<{
  item: RssItem;
  guid: string;
}> {
  return items.sort((a, b) => {
    const dateA = a.item.pubDate ? new Date(a.item.pubDate).getTime() : 0;
    const dateB = b.item.pubDate ? new Date(b.item.pubDate).getTime() : 0;
    return dateA - dateB;
  });
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

    const rss = parsed.rss || parsed.RDF || parsed.feed;
    if (!rss) {
      logger.warn({ feedUrl }, `RSS feed "${label}" has unrecognizable format`);
      return [];
    }

    const channel = rss.channel || rss;
    let items: RssItem[] = channel.item || rss.item || [];

    if (!Array.isArray(items)) {
      items = [items];
    }

    return items
      .map((item: RssItem) => ({ item, guid: extractGuid(item, feedUrl) }))
      .filter((entry) => entry.guid);
  } catch (err) {
    logger.warn({ feedUrl, err }, `RSS feed "${label}" fetch failed`);
    return [];
  }
}

export interface RssPollerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, unknown>;
}

let pollerRunning = false;

export async function pollOnce(deps: RssPollerDeps): Promise<void> {
  const config = readRssConfig();
  if (config.length === 0) return;

  const groups = deps.registeredGroups();

  for (const channel of config) {
    const channelConfig = channel as RssChannelConfig;
    if (!(channelConfig.jid in groups)) {
      logger.debug(
        { jid: channelConfig.jid },
        'RSS: skipping unregistered channel',
      );
      continue;
    }

    for (const feed of channelConfig.feeds) {
      const items = await fetchFeed(feed.url, feed.name);
      const newItems = items.filter(
        (entry) => !hasSeenItem(feed.url, entry.guid),
      );
      const sorted = sortByPubDate(newItems);

      for (const entry of sorted) {
        const label = feed.name || feed.url;
        const title = entry.item.title?.trim() || '(no title)';
        const link = entry.item.link?.trim() || '';
        const text = link ? `📰 **${label}**: ${title}\n${link}` : `📰 **${label}**: ${title}`;

        markItemSeen(feed.url, entry.guid);
        await deps.sendMessage(channelConfig.jid, text);
      }
    }
  }
}

export function startRssPoller(deps: RssPollerDeps): void {
  if (pollerRunning) {
    logger.debug('RSS poller already running, skipping duplicate start');
    return;
  }
  pollerRunning = true;
  logger.info(
    { intervalMs: RSS_POLL_INTERVAL },
    'RSS poller started (15-minute interval)',
  );

  const loop = async () => {
    try {
      await pollOnce(deps);
    } catch (err) {
      logger.error({ err }, 'Error in RSS poller loop');
    }
    setTimeout(loop, RSS_POLL_INTERVAL);
  };

  loop();
}

/** @internal - テスト用のみ。 */
export function _resetRssPollerForTests(): void {
  pollerRunning = false;
}