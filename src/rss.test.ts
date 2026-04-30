import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  _forceRssSeenItemTimestamp,
  _initTestDatabase,
  cleanupRssSeenItems,
  getSeenItemIds,
  hasSeenItem,
  markItemSeen,
} from './db.js';
import { readRssConfig, invalidateRssConfigCache } from './rss-config.js';
import { pollOnce, _resetRssPollerForTests } from './rss-poller.js';

function makeTempYaml(content: string): string {
  const p = path.join(os.tmpdir(), `nanoclaw-test-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

describe('rss-config', () => {
  beforeEach(() => {
    invalidateRssConfigCache();
  });

  afterEach(() => {
    invalidateRssConfigCache();
  });

  it('returns empty array when file does not exist', () => {
    expect(readRssConfig('/nonexistent/path/nanoclaw.yaml')).toEqual([]);
  });

  it('returns empty array when nanoclaw.yaml has no rss section', () => {
    const p = makeTempYaml(
      'providers:\n  default:\n    provider: anthropic\n    model: claude-sonnet-4-20250514\n',
    );
    try {
      expect(readRssConfig(p)).toEqual([]);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('parses rss.channels from nanoclaw.yaml', () => {
    const p = makeTempYaml(`rss:
  channels:
    - jid: "dc:1234"
      feeds:
        - url: "https://example.com/feed.xml"
          name: "Example"
        - url: "https://other.com/rss"
    - jid: "dc:5678"
      feeds:
        - url: "https://news.com/rss"
`);
    try {
      const config = readRssConfig(p);
      expect(config).toHaveLength(2);
      expect(config[0].jid).toBe('dc:1234');
      expect(config[0].feeds).toHaveLength(2);
      expect(config[0].feeds[0]).toEqual({
        url: 'https://example.com/feed.xml',
        name: 'Example',
      });
      expect(config[0].feeds[1]).toEqual({ url: 'https://other.com/rss' });
      expect(config[1].jid).toBe('dc:5678');
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('skips invalid channel entries', () => {
    const p = makeTempYaml(`rss:
  channels:
    - jid: "dc:valid"
      feeds:
        - url: "https://example.com/feed.xml"
    - feeds:
        - url: "https://example.com/feed.xml"
    - jid: "no-feeds"
      feeds: "not-array"
`);
    try {
      const config = readRssConfig(p);
      expect(config).toHaveLength(1);
      expect(config[0].jid).toBe('dc:valid');
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('skips feed entries without url', () => {
    const p = makeTempYaml(`rss:
  channels:
    - jid: "dc:1234"
      feeds:
        - name: "No URL"
        - url: "https://example.com/feed.xml"
`);
    try {
      const config = readRssConfig(p);
      expect(config).toHaveLength(1);
      expect(config[0].feeds).toHaveLength(1);
      expect(config[0].feeds[0].url).toBe('https://example.com/feed.xml');
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('returns cached result when file mtime is unchanged', () => {
    const p = makeTempYaml(`rss:
  channels:
    - jid: "dc:1234"
      feeds:
        - url: "https://example.com/feed.xml"
`);
    try {
      const first = readRssConfig(p);
      const second = readRssConfig(p);
      expect(second).toBe(first);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('re-reads config when file mtime changes', () => {
    const p = makeTempYaml(`rss:
  channels:
    - jid: "dc:original"
      feeds:
        - url: "https://example.com/feed.xml"
`);
    try {
      const first = readRssConfig(p);
      expect(first[0].jid).toBe('dc:original');

      fs.writeFileSync(
        p,
        `rss:\n  channels:\n    - jid: "dc:updated"\n      feeds:\n        - url: "https://example.com/new.xml"\n`,
        'utf-8',
      );
      // bump mtime by 1 second to guarantee a different value
      const future = new Date(Date.now() + 1000);
      fs.utimesSync(p, future, future);

      const second = readRssConfig(p);
      expect(second[0].jid).toBe('dc:updated');
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe('rss_seen_items', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('returns false for unseen items', () => {
    expect(hasSeenItem('https://example.com/feed', 'article-1')).toBe(false);
  });

  it('marks and detects seen items', () => {
    markItemSeen('https://example.com/feed', 'article-1');
    expect(hasSeenItem('https://example.com/feed', 'article-1')).toBe(true);
    expect(hasSeenItem('https://example.com/feed', 'article-2')).toBe(false);
  });

  it('differentiates by feed URL', () => {
    markItemSeen('https://example.com/feed1', 'article-1');
    expect(hasSeenItem('https://example.com/feed1', 'article-1')).toBe(true);
    expect(hasSeenItem('https://example.com/feed2', 'article-1')).toBe(false);
  });

  it('handles duplicate markItemSeen gracefully (INSERT OR IGNORE)', () => {
    markItemSeen('https://example.com/feed', 'article-1');
    markItemSeen('https://example.com/feed', 'article-1');
    expect(hasSeenItem('https://example.com/feed', 'article-1')).toBe(true);
  });

  it('getSeenItemIds returns only seen items in one query', () => {
    markItemSeen('https://example.com/feed', 'a');
    markItemSeen('https://example.com/feed', 'b');
    const seen = getSeenItemIds('https://example.com/feed', ['a', 'b', 'c']);
    expect(seen).toEqual(new Set(['a', 'b']));
  });

  it('cleanupRssSeenItems deletes old records and keeps recent ones', () => {
    markItemSeen('https://example.com/feed', 'old-article');
    markItemSeen('https://example.com/feed', 'new-article');

    // old-article の seen_at を91日前に書き換える
    const ninetyOneDaysAgo = new Date(
      Date.now() - 91 * 24 * 60 * 60 * 1000,
    ).toISOString();
    _forceRssSeenItemTimestamp(
      'https://example.com/feed',
      'old-article',
      ninetyOneDaysAgo,
    );

    const deleted = cleanupRssSeenItems();
    expect(deleted).toBe(1);
    expect(hasSeenItem('https://example.com/feed', 'old-article')).toBe(false);
    expect(hasSeenItem('https://example.com/feed', 'new-article')).toBe(true);
  });
});

describe('rss-poller', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetRssPollerForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pollOnce skips unregistered channels', async () => {
    const sentMessages: Array<{ jid: string; text: string }> = [];
    await pollOnce({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({}),
      getConfig: () => [
        {
          jid: 'dc:unregistered',
          feeds: [{ url: 'https://example.com/rss' }],
        },
      ],
    });
    expect(sentMessages).toHaveLength(0);
  });

  it('pollOnce fetches feed and sends new items', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Article One</title>
      <link>https://example.com/article-1</link>
      <guid>guid-1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/article-2</link>
      <guid>guid-2</guid>
      <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => rssXml }),
    );

    const sentMessages: Array<{ jid: string; text: string }> = [];
    await pollOnce({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({ 'dc:123': {} }),
      getConfig: () => [
        { jid: 'dc:123', feeds: [{ url: 'https://example.com/rss' }] },
      ],
      burstDelayMs: 0,
    });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].text).toContain('https://example.com/article-1');
    expect(sentMessages[1].text).toContain('https://example.com/article-2');
  });

  it('pollOnce does not re-send already seen items', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Already Seen</title>
      <link>https://example.com/article-1</link>
      <guid>guid-seen</guid>
    </item>
  </channel>
</rss>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => rssXml }),
    );

    markItemSeen('https://example.com/rss', 'guid-seen');

    const sentMessages: Array<{ jid: string; text: string }> = [];
    await pollOnce({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({ 'dc:123': {} }),
      getConfig: () => [
        { jid: 'dc:123', feeds: [{ url: 'https://example.com/rss' }] },
      ],
    });

    expect(sentMessages).toHaveLength(0);
  });

  it('pollOnce delivers items in pubDate ascending order', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Newer</title>
      <link>https://example.com/newer</link>
      <guid>guid-newer</guid>
      <pubDate>Wed, 03 Jan 2024 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Older</title>
      <link>https://example.com/older</link>
      <guid>guid-older</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => rssXml }),
    );

    const sentMessages: Array<{ jid: string; text: string }> = [];
    await pollOnce({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({ 'dc:123': {} }),
      getConfig: () => [
        { jid: 'dc:123', feeds: [{ url: 'https://example.com/rss' }] },
      ],
      burstDelayMs: 0,
    });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].text).toContain('https://example.com/older');
    expect(sentMessages[1].text).toContain('https://example.com/newer');
  });

  it('pollOnce delivers undated items after dated items', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>No Date</title>
      <link>https://example.com/no-date</link>
      <guid>guid-no-date</guid>
    </item>
    <item>
      <title>Dated</title>
      <link>https://example.com/dated</link>
      <guid>guid-dated</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => rssXml }),
    );

    const sentMessages: Array<{ jid: string; text: string }> = [];
    await pollOnce({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({ 'dc:123': {} }),
      getConfig: () => [
        { jid: 'dc:123', feeds: [{ url: 'https://example.com/rss' }] },
      ],
      burstDelayMs: 0,
    });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].text).toContain('https://example.com/dated');
    expect(sentMessages[1].text).toContain('https://example.com/no-date');
  });

  it('pollOnce continues on fetch failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );

    const sentMessages: Array<{ jid: string; text: string }> = [];
    await expect(
      pollOnce({
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
        },
        registeredGroups: () => ({ 'dc:123': {} }),
        getConfig: () => [
          { jid: 'dc:123', feeds: [{ url: 'https://example.com/rss' }] },
        ],
      }),
    ).resolves.not.toThrow();

    expect(sentMessages).toHaveLength(0);
  });
});
