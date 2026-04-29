import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase, hasSeenItem, markItemSeen } from './db.js';
import { readRssConfig, invalidateRssConfigCache } from './rss-config.js';
import { pollOnce, _resetRssPollerForTests } from './rss-poller.js';

const YAML_PATH = path.join(process.cwd(), 'nanoclaw.yaml');

describe('rss-config', () => {
  let originalYaml: string | null = null;

  beforeEach(() => {
    invalidateRssConfigCache();
    try {
      originalYaml = fs.readFileSync(YAML_PATH, 'utf-8');
    } catch {
      originalYaml = null;
    }
  });

  afterEach(() => {
    invalidateRssConfigCache();
    if (originalYaml !== null) {
      fs.writeFileSync(YAML_PATH, originalYaml, 'utf-8');
    } else {
      try {
        fs.unlinkSync(YAML_PATH);
      } catch {
        /* already removed */
      }
    }
  });

  it('returns empty array when nanoclaw.yaml does not exist', () => {
    try {
      fs.unlinkSync(YAML_PATH);
    } catch {
      /* ok */
    }
    expect(readRssConfig()).toEqual([]);
  });

  it('returns empty array when nanoclaw.yaml has no rss section', () => {
    fs.writeFileSync(
      YAML_PATH,
      'providers:\n  default:\n    provider: anthropic\n    model: claude-sonnet-4-20250514\n',
      'utf-8',
    );
    expect(readRssConfig()).toEqual([]);
  });

  it('parses rss.channels from nanoclaw.yaml', () => {
    fs.writeFileSync(
      YAML_PATH,
      `providers:
  default:
    provider: anthropic
    model: claude-sonnet-4-20250514
rss:
  channels:
    - jid: "dc:1234"
      feeds:
        - url: "https://example.com/feed.xml"
          name: "Example"
        - url: "https://other.com/rss"
    - jid: "dc:5678"
      feeds:
        - url: "https://news.com/rss"
`,
      'utf-8',
    );
    const config = readRssConfig();
    expect(config).toHaveLength(2);
    expect(config[0].jid).toBe('dc:1234');
    expect(config[0].feeds).toHaveLength(2);
    expect(config[0].feeds[0]).toEqual({
      url: 'https://example.com/feed.xml',
      name: 'Example',
    });
    expect(config[0].feeds[1]).toEqual({ url: 'https://other.com/rss' });
    expect(config[1].jid).toBe('dc:5678');
  });

  it('skips invalid channel entries', () => {
    fs.writeFileSync(
      YAML_PATH,
      `rss:
  channels:
    - jid: "dc:valid"
      feeds:
        - url: "https://example.com/feed.xml"
    - feeds:
        - url: "https://example.com/feed.xml"
    - jid: "no-feeds"
      feeds: "not-array"
`,
      'utf-8',
    );
    const config = readRssConfig();
    expect(config).toHaveLength(1);
    expect(config[0].jid).toBe('dc:valid');
  });

  it('skips feed entries without url', () => {
    fs.writeFileSync(
      YAML_PATH,
      `rss:
  channels:
    - jid: "dc:1234"
      feeds:
        - name: "No URL"
        - url: "https://example.com/feed.xml"
`,
      'utf-8',
    );
    const config = readRssConfig();
    expect(config).toHaveLength(1);
    expect(config[0].feeds).toHaveLength(1);
    expect(config[0].feeds[0].url).toBe('https://example.com/feed.xml');
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
});

describe('rss-poller', () => {
  beforeEach(() => {
    _resetRssPollerForTests();
  });

  it('pollOnce skips unregistered channels', async () => {
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sentMessages.push({ jid, text });
      },
      registeredGroups: () => ({}),
    };

    await pollOnce(deps);
    expect(sentMessages).toHaveLength(0);
  });
});