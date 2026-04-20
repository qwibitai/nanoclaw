import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';

import { chromium, BrowserContext, Page } from 'playwright';

import { logger } from './logger.js';

export interface HistoryEntry {
  title: string;
  url: string;
  channelName: string;
  channelUrl: string;
  watchedAt: string;
  duration: string;
}

interface SearchPayload {
  query: string;
  maxResults?: number;
}

interface YouTubeHistoryServiceHandle {
  close: () => Promise<void>;
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const YOUTUBE_HISTORY_URL = 'https://www.youtube.com/feed/history';

function getProfileDir(): string {
  return path.join(
    os.homedir(),
    '.config',
    'nanoclaw',
    'youtube-chrome-profile',
  );
}

function toHttpUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
  if (rawUrl.startsWith('/')) return `https://www.youtube.com${rawUrl}`;
  return rawUrl;
}

function normalizeResultsLimit(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  details?: string,
): void {
  sendJson(res, status, {
    ok: false,
    error: message,
    details,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) return {};
  return JSON.parse(body);
}

function isLoggedInFromCookies(cookies: { name: string }[]): boolean {
  const names = new Set(cookies.map((c) => c.name));
  return (
    names.has('SAPISID') ||
    names.has('__Secure-3PSID') ||
    names.has('__Secure-1PSID')
  );
}

async function waitForHistorySearchInput(page: Page): Promise<string> {
  const selectors = [
    'input#search',
    'input[aria-label*="Search watch history" i]',
    'input[placeholder*="Search watch history" i]',
    'ytd-feed-filter-chip-bar-renderer input#search',
    'ytd-search-box input#search',
  ];
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    await handle.scrollIntoViewIfNeeded().catch(() => undefined);
    return selector;
  }
  throw new Error('Could not find YouTube watch-history search input');
}

async function scrapeEntries(
  page: Page,
  limit: number,
): Promise<HistoryEntry[]> {
  const selector =
    'ytd-video-renderer, ytd-item-section-renderer ytd-video-renderer';
  await page.waitForSelector(selector, { timeout: 15000 });
  const rows = await page.$$eval(
    selector,
    (items, max) =>
      items.slice(0, max).map((item) => {
        const titleAnchor = item.querySelector('a#video-title');
        const channelAnchor = item.querySelector(
          '#channel-name a, ytd-channel-name a',
        );
        const metadataSpans = Array.from(
          item.querySelectorAll('#metadata-line span'),
        )
          .map((el) =>
            String((el as { textContent?: string }).textContent || '').trim(),
          )
          .filter(Boolean);
        const durationEl = item.querySelector(
          'ytd-thumbnail-overlay-time-status-renderer span',
        );
        const watchedAt =
          metadataSpans.find((span) =>
            /ago|分钟前|小时前|天前|周前|月前|年前/i.test(span),
          ) ||
          metadataSpans[metadataSpans.length - 1] ||
          '';
        return {
          title: titleAnchor?.textContent?.trim() || '',
          url: titleAnchor?.href || '',
          channelName: channelAnchor?.textContent?.trim() || '',
          channelUrl: channelAnchor?.href || '',
          watchedAt,
          duration: durationEl?.textContent?.trim() || '',
        };
      }),
    limit,
  );
  return rows.map((row) => ({
    title: row.title,
    url: toHttpUrl(row.url),
    channelName: row.channelName,
    channelUrl: toHttpUrl(row.channelUrl),
    watchedAt: row.watchedAt,
    duration: row.duration,
  }));
}

export function startYouTubeHistoryService(
  port: number,
  bindHost: string,
): Promise<YouTubeHistoryServiceHandle> {
  let context: BrowserContext | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let pending = Promise.resolve();

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeBrowser().catch((err) =>
        logger.warn({ err }, 'Failed to close YouTube browser on idle'),
      );
    }, DEFAULT_IDLE_MS);
  };

  const closeBrowser = async () => {
    if (!context) return;
    const oldContext = context;
    context = null;
    await oldContext.close();
    logger.info('YouTube history browser closed');
  };

  const ensureContext = async (): Promise<BrowserContext> => {
    if (context) {
      touchIdle();
      return context;
    }
    context = await chromium.launchPersistentContext(getProfileDir(), {
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: ['--disable-dev-shm-usage'],
    });
    logger.info(
      { profileDir: getProfileDir() },
      'YouTube history browser opened',
    );
    touchIdle();
    return context;
  };

  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = pending.then(fn);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const getStatus = async () =>
    withLock(async () => {
      const running = !!context;
      const cookies = running
        ? await context!.cookies(['https://www.youtube.com'])
        : [];
      return {
        browserRunning: running,
        loggedIn: isLoggedInFromCookies(cookies),
        profileDir: getProfileDir(),
      };
    });

  const runSearch = async (query: string, maxResults: number) =>
    withLock(async () => {
      const ctx = await ensureContext();
      const page = await ctx.newPage();
      try {
        await page.goto(YOUTUBE_HISTORY_URL, { waitUntil: 'domcontentloaded' });
        const selector = await waitForHistorySearchInput(page);
        await page.fill(selector, query);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const entries = await scrapeEntries(page, maxResults);
        return entries;
      } finally {
        await page.close().catch(() => undefined);
      }
    });

  const runRecent = async (maxResults: number) =>
    withLock(async () => {
      const ctx = await ensureContext();
      const page = await ctx.newPage();
      try {
        await page.goto(YOUTUBE_HISTORY_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        return await scrapeEntries(page, maxResults);
      } finally {
        await page.close().catch(() => undefined);
      }
    });

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const requestUrl = new URL(req.url || '/', 'http://localhost');

      if (method === 'GET' && requestUrl.pathname === '/api/status') {
        const status = await getStatus();
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (method === 'POST' && requestUrl.pathname === '/api/search') {
        const body = (await readJsonBody(req)) as SearchPayload;
        const query = String(body.query || '').trim();
        if (!query) {
          return sendError(res, 400, 'query is required');
        }
        const maxResults = normalizeResultsLimit(body.maxResults, 20);
        const entries = await runSearch(query, maxResults);
        return sendJson(res, 200, {
          ok: true,
          query,
          count: entries.length,
          items: entries,
        });
      }

      if (method === 'GET' && requestUrl.pathname === '/api/recent') {
        const maxResults = normalizeResultsLimit(
          requestUrl.searchParams.get('limit'),
          20,
        );
        const entries = await runRecent(maxResults);
        return sendJson(res, 200, {
          ok: true,
          count: entries.length,
          items: entries,
        });
      }

      return sendError(res, 404, 'not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'YouTube history service request failed');
      return sendError(res, 500, 'request failed', message);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      logger.info({ bindHost, port }, 'YouTube history service started');
      resolve({
        close: async () => {
          if (idleTimer) clearTimeout(idleTimer);
          await closeBrowser();
          await new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          );
        },
      });
    });
  });
}
