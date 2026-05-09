import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const WORKER_PATH = resolve(import.meta.dir, '../../scripts/news-fetch-worker.ts');

function rssFeed(items: Array<{ title: string; link: string; pubDate: string; desc?: string }>) {
  const body = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <link>${i.link}</link>
      <pubDate>${i.pubDate}</pubDate>
      ${i.desc ? `<description><![CDATA[${i.desc}]]></description>` : ''}
    </item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${body}</channel></rss>`;
}

function atomFeed(entries: Array<{ title: string; link: string; updated: string }>) {
  const body = entries
    .map(
      (e) => `
    <entry>
      <title>${e.title}</title>
      <link href="${e.link}"/>
      <updated>${e.updated}</updated>
    </entry>`,
    )
    .join('');
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>${body}</feed>`;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmp: string;

beforeAll(() => {
  const now = Date.now();
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toUTCString();
  const minutesAgoIso = (m: number) => new Date(now - m * 60_000).toISOString();

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      switch (u.pathname) {
        case '/rss':
          return new Response(
            rssFeed([
              { title: 'Fresh A', link: 'https://x/a', pubDate: minutesAgo(60), desc: 'aaa' },
              { title: 'Fresh B', link: 'https://x/b', pubDate: minutesAgo(120) },
              { title: 'Stale', link: 'https://x/old', pubDate: minutesAgo(60 * 48) },
            ]),
            { headers: { 'content-type': 'application/rss+xml' } },
          );
        case '/atom':
          return new Response(
            atomFeed([{ title: 'Atom A', link: 'https://x/atom-a', updated: minutesAgoIso(30) }]),
            { headers: { 'content-type': 'application/atom+xml' } },
          );
        case '/html':
          return new Response('<html><body>not a feed</body></html>', {
            headers: { 'content-type': 'text/html' },
          });
        case '/500':
          return new Response('boom', { status: 500 });
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  baseUrl = `http://localhost:${server.port}`;
  tmp = mkdtempSync(join(tmpdir(), 'news-fetch-test-'));
});

afterAll(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

async function runWorker(config: object | null): Promise<{ stdout: string; exitCode: number }> {
  const env: Record<string, string> = { ...process.env };
  if (config !== null) {
    const path = join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(config));
    env.NEWS_SOURCES_PATH = path;
  } else {
    env.NEWS_SOURCES_PATH = join(tmp, 'does-not-exist.json');
  }
  const proc = Bun.spawn(['bun', WORKER_PATH], { env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

function lastJsonLine(stdout: string): any {
  const trimmed = stdout.trim();
  const lastNl = trimmed.lastIndexOf('\n');
  return JSON.parse(lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1));
}

describe('news-fetch-worker (daily news briefing task)', () => {
  it('returns empty sources with a note when config is missing', async () => {
    const { stdout, exitCode } = await runWorker(null);
    expect(exitCode).toBe(0);
    const out = lastJsonLine(stdout);
    expect(out.wakeAgent).toBe(true);
    expect(out.data.sources).toEqual([]);
    expect(out.data.note).toContain('no news-sources.json');
  });

  it('parses RSS + Atom feeds, filters by recency, and reports errors', async () => {
    const { stdout, exitCode } = await runWorker({
      sources: [
        { url: `${baseUrl}/rss`, label: 'RSS' },
        { url: `${baseUrl}/atom`, label: 'Atom' },
        { url: `${baseUrl}/html`, label: 'NotFeed' },
        { url: `${baseUrl}/500`, label: 'ServerErr' },
      ],
      windowHours: 24,
      maxItemsPerSource: 10,
      totalBudget: 30000,
    });
    expect(exitCode).toBe(0);
    const out = lastJsonLine(stdout);
    expect(out.wakeAgent).toBe(true);
    expect(out.data.windowHours).toBe(24);
    expect(typeof out.data.fetchedAt).toBe('string');

    const byLabel = Object.fromEntries(out.data.sources.map((s: any) => [s.label, s]));

    // RSS: 2 fresh items kept, 1 stale dropped
    expect(byLabel.RSS.items).toHaveLength(2);
    expect(byLabel.RSS.items.map((i: any) => i.title).sort()).toEqual(['Fresh A', 'Fresh B']);
    expect(byLabel.RSS.items[0].pubDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const a = byLabel.RSS.items.find((i: any) => i.title === 'Fresh A');
    expect(a.link).toBe('https://x/a');
    expect(a.summary).toBe('aaa');

    // Atom: 1 fresh entry, link extracted from href attribute
    expect(byLabel.Atom.items).toHaveLength(1);
    expect(byLabel.Atom.items[0].title).toBe('Atom A');
    expect(byLabel.Atom.items[0].link).toBe('https://x/atom-a');

    // Non-feed and HTTP errors surfaced, not silently rendered
    expect(byLabel.NotFeed.error).toBe('not RSS/Atom');
    expect(byLabel.NotFeed.items).toBeUndefined();
    expect(byLabel.ServerErr.error).toBe('HTTP 500');
  });

  it('enforces totalBudget by dropping trailing items', async () => {
    // Tiny budget — only the first item from the first source should survive.
    const { stdout, exitCode } = await runWorker({
      sources: [
        { url: `${baseUrl}/rss`, label: 'RSS' },
        { url: `${baseUrl}/atom`, label: 'Atom' },
      ],
      windowHours: 24,
      maxItemsPerSource: 10,
      totalBudget: 150,
    });
    expect(exitCode).toBe(0);
    const out = lastJsonLine(stdout);
    const totalItems = out.data.sources.reduce(
      (n: number, s: any) => n + (s.items?.length ?? 0),
      0,
    );
    expect(totalItems).toBeLessThan(3);
    expect(out.data.totalChars).toBeLessThanOrEqual(150 + 200); // small slack for first item
  });
});
