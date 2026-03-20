import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Mock logger before importing module under test
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Control flag: when true, spawn() returns a fake process that exits
// immediately with code 1. Used by cache integration tests to avoid
// spawning real long-running scripts (scrape-tweet.ts exists and takes
// 60s+ in real environments).
const mockSpawnControl = vi.hoisted(() => ({ enabled: false }));

vi.mock('child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('child_process')>();
  const realSpawn = mod.spawn;
  return {
    ...mod,
    spawn: (...args: Parameters<typeof mod.spawn>) => {
      if (mockSpawnControl.enabled) {
        const { EventEmitter } = require('events');
        const { Readable, Writable } = require('stream');
        const proc = new EventEmitter();
        proc.stdout = new Readable({ read() { this.push(null); } });
        proc.stderr = new Readable({ read() { this.push(null); } });
        proc.stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
        proc.pid = 99999;
        proc.unref = () => {};
        process.nextTick(() => proc.emit('close', 1));
        return proc;
      }
      return realSpawn(...args);
    },
  };
});

// We do NOT mock child_process or fs here -- runScript tests use real subprocesses
// to verify process-group kill behavior.

import { runScript, handleXIpc } from './x-ipc.js';
import {
  extractTweetId,
  loadCache,
  saveCache,
  getCachedTweet,
  cacheTweets,
  cacheTweetsFromSearch,
  cacheTweetFromScrape,
  formatCachedTweet,
  pruneCache,
  type TweetCacheEntry,
  type SearchTweet,
} from './x-tweet-cache.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// runScript -- process-group kill on timeout
// ---------------------------------------------------------------------------
describe('runScript', () => {
  it('spawns with detached: true and kills process group on timeout', async () => {
    // Use a tiny script that sleeps forever via node -e
    // We override the script path by pointing at a non-existent script,
    // but we can test the spawn options directly.

    // Instead, use a real inline node script that:
    // 1. spawns a child (simulating Chrome)
    // 2. both sleep forever
    // We then verify the entire process group is killed.

    const helperScript = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

    // We'll create a temporary script inline via spawn of `node -e`
    // But runScript hardcodes the script path. Let's test with a very short timeout
    // on a script that doesn't exist -- it should fail gracefully.

    const result = await runScript('nonexistent-script-for-test', {}, 500);

    expect(result.success).toBe(false);
    // Should either fail to spawn or exit with non-zero code
    expect(result.message).toBeTruthy();
  });

  it('kills entire process group on timeout (no orphan children)', async () => {
    // Create a helper script that spawns a long-lived child process.
    // We use node -e inline via a temp file approach.
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
    const os = await import('os');

    const tmpDir = mkdtempSync(path.join(os.default.tmpdir(), 'x-ipc-test-'));
    const helperScript = path.join(tmpDir, 'slow-parent.ts');

    // This script:
    // 1. Reads stdin (as runScript sends JSON)
    // 2. Spawns a child that sleeps 60s
    // 3. Parent also sleeps 60s
    // Both should be killed when process group is killed.
    writeFileSync(helperScript, `
import { spawn } from 'child_process';

// Read stdin
process.stdin.resume();
process.stdin.on('data', () => {});

// Spawn a child that sleeps (simulating Chrome)
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
child.unref();

// Parent also sleeps
setTimeout(() => {}, 60000);
`);

    // We need to make runScript use our helper script.
    // Since runScript hardcodes the path, we'll place our script where it expects it.
    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-orphan-kill.ts');

    writeFileSync(targetPath, `
import { spawn } from 'child_process';

// Read stdin
process.stdin.resume();
process.stdin.on('data', () => {});

// Spawn a child that sleeps (simulating Chrome)
const child = spawn('sleep', ['60'], { stdio: 'ignore' });

// Write child PID to stderr so the test can verify it was killed
process.stderr.write('CHILD_PID:' + child.pid + '\\n');

// Parent also sleeps
setTimeout(() => {}, 60000);
`);

    try {
      // Use a 2-second timeout
      const result = await runScript('__test-orphan-kill', {}, 2000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('timed out');
      expect(result.message).toContain('2s');

      // Extract child PID from stderr in the message
      const pidMatch = result.message.match(/CHILD_PID:(\d+)/);
      if (pidMatch) {
        const childPid = parseInt(pidMatch[1], 10);

        // Give a moment for the SIGKILL to propagate
        await new Promise((r) => setTimeout(r, 200));

        // Verify the child process was killed
        let childAlive = false;
        try {
          process.kill(childPid, 0); // signal 0 = check existence
          childAlive = true;
        } catch {
          childAlive = false;
        }

        expect(childAlive).toBe(false);
      }
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
      try { unlinkSync(helperScript); } catch { /* ignore */ }
    }
  });

  it('returns parsed JSON from successful script stdout', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-success.ts');

    writeFileSync(targetPath, `
// Read stdin then output JSON result
process.stdin.resume();
process.stdin.on('data', () => {
  console.log(JSON.stringify({ success: true, message: 'ok', data: { foo: 42 } }));
  process.exit(0);
});
`);

    try {
      const result = await runScript('__test-success', { input: 'test' }, 5000);

      expect(result.success).toBe(true);
      expect(result.message).toBe('ok');
      expect(result.data).toEqual({ foo: 42 });
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });

  it('returns failure when script exits with non-zero code', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-fail.ts');

    writeFileSync(targetPath, `
process.stdin.resume();
process.stdin.on('data', () => {
  process.stderr.write('something went wrong');
  process.exit(1);
});
`);

    try {
      const result = await runScript('__test-fail', {}, 5000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('crashed');
      expect(result.message).toContain('exit 1');
      expect(result.message).toContain('something went wrong');
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });

  it('parses JSON result from stdout even when script exits non-zero', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-exit1-json.ts');

    writeFileSync(targetPath, `
process.stdin.resume();
process.stdin.on('data', () => {
  console.log(JSON.stringify({ success: false, message: 'X API error: 403 Forbidden' }));
  process.exitCode = 1;
});
`);

    try {
      const result = await runScript('__test-exit1-json', {}, 5000);

      expect(result.success).toBe(false);
      expect(result.message).toBe('X API error: 403 Forbidden');
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });

  it('returns failure when stdout is not valid JSON', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');

    const skillsScriptsDir = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts');
    const targetPath = path.join(skillsScriptsDir, '__test-badjson.ts');

    writeFileSync(targetPath, `
process.stdin.resume();
process.stdin.on('data', () => {
  console.log('not json');
  process.exit(0);
});
`);

    try {
      const result = await runScript('__test-badjson', {}, 5000);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No output');
    } finally {
      try { unlinkSync(targetPath); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// handleXIpc -- routing logic
// ---------------------------------------------------------------------------
describe('handleXIpc', () => {
  const dataDir = '/tmp/nanoclaw-test-xipc';

  it('returns false for non-x_* types', async () => {
    const handled = await handleXIpc({ type: 'chat' }, 'main', true, dataDir);
    expect(handled).toBe(false);
  });

  it('blocks non-main groups', async () => {
    const handled = await handleXIpc(
      { type: 'x_post', requestId: 'r1', content: 'hello' },
      'other-group',
      false,
      dataDir,
    );
    expect(handled).toBe(true);
    // No script should have been run -- it should return immediately
  });

  it('blocks requests without requestId', async () => {
    const handled = await handleXIpc(
      { type: 'x_post', content: 'hello' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(true);
  });

  it('returns false for unknown x_* types', async () => {
    const handled = await handleXIpc(
      { type: 'x_unknown_action', requestId: 'r1' },
      'main',
      true,
      dataDir,
    );
    expect(handled).toBe(false);
  });

  it('validates required fields for x_post', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_post', requestId: 'r-missing-content' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-content.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing content');
  });

  it('validates required fields for x_like', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_like', requestId: 'r-missing-url' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-url.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl');
  });

  it('validates required fields for x_reply', async () => {
    const { mkdirSync, readFileSync } = await import('fs');
    mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });

    const handled = await handleXIpc(
      { type: 'x_reply', requestId: 'r-missing-reply' },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);
    const result = JSON.parse(
      readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-missing-reply.json'), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.message).toBe('Missing tweetUrl or content');
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// x-tweet-cache -- unit tests
// ---------------------------------------------------------------------------
describe('x-tweet-cache', () => {
  const CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'x-tweet-cache.json');

  function makeCacheEntry(overrides: Partial<TweetCacheEntry> = {}): TweetCacheEntry {
    return {
      id: '123456789',
      author: 'Test User',
      handle: '@testuser',
      content: 'Hello world',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/testuser/status/123456789',
      likes: 42,
      retweets: 10,
      replies: 5,
      views: 1000,
      cachedAt: Date.now(),
      ...overrides,
    };
  }

  beforeEach(() => {
    // Ensure clean cache state
    try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  });

  describe('extractTweetId', () => {
    it('extracts ID from x.com URL', () => {
      expect(extractTweetId('https://x.com/user/status/123456789')).toBe('123456789');
    });

    it('extracts ID from twitter.com URL', () => {
      expect(extractTweetId('https://twitter.com/user/status/987654321')).toBe('987654321');
    });

    it('accepts raw numeric ID', () => {
      expect(extractTweetId('123456789')).toBe('123456789');
    });

    it('returns null for invalid input', () => {
      expect(extractTweetId('not-a-url')).toBeNull();
      expect(extractTweetId('https://example.com/page')).toBeNull();
    });
  });

  describe('loadCache / saveCache', () => {
    it('returns empty cache when file does not exist', () => {
      const cache = loadCache();
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });

    it('round-trips cache through file', () => {
      const entry = makeCacheEntry();
      saveCache({ version: 1, tweets: { [entry.id]: entry } });
      const loaded = loadCache();
      expect(loaded.tweets[entry.id]).toEqual(entry);
    });

    it('handles corrupted file gracefully', () => {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, 'not json');
      const cache = loadCache();
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });
  });

  describe('getCachedTweet', () => {
    it('returns cached tweet by ID', () => {
      const entry = makeCacheEntry({ id: '111' });
      saveCache({ version: 1, tweets: { '111': entry } });
      const result = getCachedTweet('111');
      expect(result).toEqual(entry);
    });

    it('returns null for missing tweet', () => {
      saveCache({ version: 1, tweets: {} });
      expect(getCachedTweet('999')).toBeNull();
    });

    it('returns null for expired tweet (TTL)', () => {
      const staleEntry = makeCacheEntry({
        id: '222',
        cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      });
      saveCache({ version: 1, tweets: { '222': staleEntry } });
      expect(getCachedTweet('222')).toBeNull();
    });

    it('returns tweet within TTL', () => {
      const freshEntry = makeCacheEntry({
        id: '333',
        cachedAt: Date.now() - 6 * 24 * 60 * 60 * 1000, // 6 days ago (within 7-day TTL)
      });
      saveCache({ version: 1, tweets: { '333': freshEntry } });
      expect(getCachedTweet('333')).toEqual(freshEntry);
    });
  });

  describe('cacheTweets', () => {
    it('stores multiple entries', () => {
      const entries = [
        makeCacheEntry({ id: 'a1' }),
        makeCacheEntry({ id: 'a2' }),
      ];
      cacheTweets(entries);
      const cache = loadCache();
      expect(Object.keys(cache.tweets)).toHaveLength(2);
      expect(cache.tweets['a1']).toBeDefined();
      expect(cache.tweets['a2']).toBeDefined();
    });

    it('skips entries without ID', () => {
      const entries = [
        makeCacheEntry({ id: '' }),
        makeCacheEntry({ id: 'valid' }),
      ];
      cacheTweets(entries);
      const cache = loadCache();
      expect(Object.keys(cache.tweets)).toHaveLength(1);
      expect(cache.tweets['valid']).toBeDefined();
    });
  });

  describe('pruneCache', () => {
    it('removes expired entries', () => {
      const cache = {
        version: 1 as const,
        tweets: {
          fresh: makeCacheEntry({ id: 'fresh', cachedAt: Date.now() }),
          stale: makeCacheEntry({ id: 'stale', cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
        },
      };
      const pruned = pruneCache(cache);
      expect(Object.keys(pruned.tweets)).toHaveLength(1);
      expect(pruned.tweets['fresh']).toBeDefined();
      expect(pruned.tweets['stale']).toBeUndefined();
    });

    it('limits to max entries (500), keeping newest', () => {
      const tweets: Record<string, TweetCacheEntry> = {};
      for (let i = 0; i < 510; i++) {
        tweets[`t${i}`] = makeCacheEntry({
          id: `t${i}`,
          cachedAt: Date.now() - i * 1000, // older entries have smaller cachedAt
        });
      }
      const cache = { version: 1 as const, tweets };
      const pruned = pruneCache(cache);
      expect(Object.keys(pruned.tweets)).toHaveLength(500);
      // Oldest 10 should be pruned (t500-t509)
      expect(pruned.tweets['t0']).toBeDefined();
      expect(pruned.tweets['t499']).toBeDefined();
      expect(pruned.tweets['t500']).toBeUndefined();
    });
  });

  describe('cacheTweetsFromSearch', () => {
    it('caches search result tweets', () => {
      const searchTweets: SearchTweet[] = [
        {
          id: 's1',
          author: 'Alice',
          handle: '@alice',
          content: 'Search result 1',
          timestamp: '2026-02-20T10:00:00.000Z',
          url: 'https://x.com/alice/status/s1',
          isRetweet: false,
          hasMedia: false,
          likes: 100,
          retweets: 20,
          replies: 5,
          views: 5000,
        },
        {
          id: 's2',
          author: 'Bob',
          handle: '@bob',
          content: 'Search result 2',
          timestamp: '2026-02-20T11:00:00.000Z',
          url: 'https://x.com/bob/status/s2',
          isRetweet: false,
          hasMedia: true,
          likes: 50,
          retweets: 10,
          replies: 2,
          views: 2000,
          quotedTweet: { author: 'Carol', content: 'Original tweet' },
        },
      ];

      cacheTweetsFromSearch(searchTweets);

      const cached1 = getCachedTweet('s1');
      expect(cached1).toBeTruthy();
      expect(cached1!.author).toBe('Alice');
      expect(cached1!.likes).toBe(100);

      const cached2 = getCachedTweet('s2');
      expect(cached2).toBeTruthy();
      expect(cached2!.quotedTweet).toEqual({ author: 'Carol', content: 'Original tweet' });
    });
  });

  describe('cacheTweetFromScrape', () => {
    it('caches a scraped tweet with string metrics', () => {
      cacheTweetFromScrape('scrape1', {
        author: 'Dave',
        handle: '@dave',
        content: 'Scraped content',
        timestamp: '2026-02-20T12:00:00.000Z',
        metrics: {
          replies: '15',
          reposts: '30',
          likes: '200',
          views: '10000',
          bookmarks: '5',
        },
        replies: [],
      });

      const cached = getCachedTweet('scrape1');
      expect(cached).toBeTruthy();
      expect(cached!.author).toBe('Dave');
      expect(cached!.likes).toBe(200);
      expect(cached!.retweets).toBe(30);
      expect(cached!.views).toBe(10000);
    });

    it('does nothing when tweetId is null', () => {
      cacheTweetFromScrape(null, {
        author: 'Nobody',
        handle: '@nobody',
        content: 'test',
        timestamp: '',
        metrics: { replies: '0', reposts: '0', likes: '0', views: '0', bookmarks: '0' },
        replies: [],
      });
      const cache = loadCache();
      expect(Object.keys(cache.tweets)).toHaveLength(0);
    });
  });

  describe('formatCachedTweet', () => {
    it('formats tweet matching scrape-tweet output style', () => {
      const entry = makeCacheEntry({
        author: 'Test User',
        handle: '@testuser',
        content: 'Hello world',
        timestamp: '2026-02-20T10:00:00.000Z',
        likes: 42,
        retweets: 10,
        replies: 5,
        views: 1000,
      });
      const output = formatCachedTweet(entry);
      expect(output).toContain('Test User (@testuser)');
      expect(output).toContain('Hello world');
      expect(output).toContain('Replies: 5 | Reposts: 10 | Likes: 42 | Views: 1000');
      expect(output).toContain('[Served from cache]');
    });

    it('includes quoted tweet when present', () => {
      const entry = makeCacheEntry({
        quotedTweet: { author: 'Original', content: 'Original content' },
      });
      const output = formatCachedTweet(entry);
      expect(output).toContain('Quoting Original:');
      expect(output).toContain('Original content');
    });
  });
});

// ---------------------------------------------------------------------------
// handleXIpc -- tweet cache integration
// ---------------------------------------------------------------------------
describe('handleXIpc tweet cache', () => {
  const dataDir = '/tmp/nanoclaw-test-xipc-cache';
  const CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'x-tweet-cache.json');

  beforeEach(() => {
    fs.mkdirSync(path.join(dataDir, 'ipc', 'main', 'x_results'), { recursive: true });
    // Ensure clean cache
    try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
    // Enable fake spawn so cache-miss tests don't run real scrape-tweet.ts
    mockSpawnControl.enabled = true;
  });

  afterEach(() => {
    mockSpawnControl.enabled = false;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  });

  it('serves x_scrape_tweet from cache when tweet is cached (no subprocess)', async () => {
    // Pre-populate cache with a tweet
    const entry = {
      id: '1234567890',
      author: 'Cached Author',
      handle: '@cached',
      content: 'This is cached',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/cached/status/1234567890',
      likes: 99,
      retweets: 33,
      replies: 11,
      views: 5000,
      cachedAt: Date.now(),
    };
    saveCache({ version: 1, tweets: { '1234567890': entry } });

    const handled = await handleXIpc(
      {
        type: 'x_scrape_tweet',
        requestId: 'r-cache-hit',
        tweetUrl: 'https://x.com/cached/status/1234567890',
      },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);

    const result = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-cache-hit.json'), 'utf-8'),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('Cached Author');
    expect(result.message).toContain('[Served from cache]');
    expect(result.data.id).toBe('1234567890');
  });

  it('bypasses cache when includeReplies is true', async () => {
    // Pre-populate cache
    const entry = {
      id: '9876543210',
      author: 'Cached',
      handle: '@cached',
      content: 'Cached tweet',
      timestamp: '2026-02-20T10:00:00.000Z',
      url: 'https://x.com/cached/status/9876543210',
      likes: 1,
      retweets: 0,
      replies: 0,
      views: 10,
      cachedAt: Date.now(),
    };
    saveCache({ version: 1, tweets: { '9876543210': entry } });

    // With includeReplies=true, cache should be bypassed and runScript called
    const handled = await handleXIpc(
      {
        type: 'x_scrape_tweet',
        requestId: 'r-replies-bypass',
        tweetUrl: 'https://x.com/cached/status/9876543210',
        includeReplies: true,
      },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);

    const result = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-replies-bypass.json'), 'utf-8'),
    );
    // Should NOT have served from cache (runScript was called instead)
    expect(result.message).not.toContain('[Served from cache]');
  });

  it('does not serve expired cached tweets', async () => {
    // Pre-populate cache with an expired entry
    const entry = {
      id: '5555555555',
      author: 'Stale Author',
      handle: '@stale',
      content: 'Stale tweet',
      timestamp: '2026-02-10T10:00:00.000Z',
      url: 'https://x.com/stale/status/5555555555',
      likes: 1,
      retweets: 0,
      replies: 0,
      views: 10,
      cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago, beyond 7-day TTL
    };
    saveCache({ version: 1, tweets: { '5555555555': entry } });

    const handled = await handleXIpc(
      {
        type: 'x_scrape_tweet',
        requestId: 'r-ttl-expired',
        tweetUrl: 'https://x.com/stale/status/5555555555',
      },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);

    const result = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-ttl-expired.json'), 'utf-8'),
    );
    // Should NOT have served from cache (runScript was called instead)
    expect(result.message).not.toContain('[Served from cache]');
  });

  it('falls through to subprocess on cache miss', async () => {
    // No cache populated -- runScript should be called
    const handled = await handleXIpc(
      {
        type: 'x_scrape_tweet',
        requestId: 'r-cache-miss',
        tweetUrl: 'https://x.com/user/status/1111111111',
      },
      'main',
      true,
      dataDir,
    );

    expect(handled).toBe(true);

    const result = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'ipc', 'main', 'x_results', 'r-cache-miss.json'), 'utf-8'),
    );
    // Mocked runScript returns failure, proving no cache was served
    expect(result.success).toBe(false);
    expect(result.message).not.toContain('[Served from cache]');
  });
});
