/**
 * X Integration - API-based Scraper Client
 *
 * Uses @the-convocation/twitter-scraper instead of Playwright browser automation.
 * Cookies are extracted once from the persistent Chrome profile and cached to disk.
 */

// Polyfill ArrayBuffer.transfer for Node < 21 (required by x-client-transaction-id)
if (!ArrayBuffer.prototype.transfer) {
  ArrayBuffer.prototype.transfer = function (newByteLength?: number): ArrayBuffer {
    const len = newByteLength !== undefined ? newByteLength : this.byteLength;
    const newBuffer = new ArrayBuffer(len);
    const src = new Uint8Array(this);
    const dst = new Uint8Array(newBuffer);
    dst.set(src.subarray(0, Math.min(this.byteLength, len)));
    return newBuffer;
  };
}

import { Scraper, SearchMode } from '@the-convocation/twitter-scraper';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export { SearchMode };
export type { Scraper };

const COOKIES_CACHE_PATH = path.join(
  path.dirname(config.browserDataDir),
  'x-cookies.json',
);

// Maximum age for cached cookies before re-extraction (12 hours)
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface CachedCookieEntry {
  key: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
}

interface CachedCookies {
  timestamp: string;
  cookies: CachedCookieEntry[];
}

/**
 * Convert a cached cookie entry to a Set-Cookie header string.
 * twitter-scraper's setCookies accepts strings which avoids tough-cookie version mismatch.
 */
function toCookieString(c: CachedCookieEntry): string {
  const parts = [`${c.key}=${c.value}`];
  if (c.domain) parts.push(`Domain=${c.domain}`);
  if (c.path) parts.push(`Path=${c.path}`);
  if (c.secure) parts.push('Secure');
  if (c.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * Extract cookies from Chrome profile via Playwright (one-time operation).
 * Falls back to cached cookies if available and fresh.
 */
async function extractCookiesFromBrowser(): Promise<CachedCookieEntry[]> {
  // Dynamic import to avoid loading Playwright when not needed
  const { chromium } = await import('playwright');

  // Clean up lock files first
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: true,
    viewport: config.viewport,
    args: config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  try {
    const playwrightCookies = await context.cookies('https://x.com');
    const xCookies = playwrightCookies
      .filter(c => c.domain.includes('x.com') || c.domain.includes('twitter.com'))
      .map(c => ({
        key: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
      }));

    // Cache to disk
    const cached: CachedCookies = {
      timestamp: new Date().toISOString(),
      cookies: xCookies,
    };
    fs.writeFileSync(COOKIES_CACHE_PATH, JSON.stringify(cached, null, 2));

    return xCookies;
  } finally {
    await context.close();
  }
}

/**
 * Load cookies from cache if fresh enough, otherwise extract from browser.
 */
async function loadCookies(): Promise<CachedCookieEntry[]> {
  // Try cached cookies first
  if (fs.existsSync(COOKIES_CACHE_PATH)) {
    try {
      const cached: CachedCookies = JSON.parse(fs.readFileSync(COOKIES_CACHE_PATH, 'utf-8'));
      const age = Date.now() - new Date(cached.timestamp).getTime();
      if (age < COOKIE_MAX_AGE_MS && cached.cookies.length > 0) {
        return cached.cookies;
      }
    } catch {
      // Cache corrupt, re-extract
    }
  }

  // Extract from browser
  return extractCookiesFromBrowser();
}

/**
 * Set cookies on a scraper instance using string format (avoids tough-cookie version mismatch).
 */
async function applyCookies(scraper: Scraper, rawCookies: CachedCookieEntry[]): Promise<void> {
  const cookieStrings = rawCookies.map(toCookieString);
  await scraper.setCookies(cookieStrings);
}

/**
 * Create and authenticate a Scraper instance.
 * Enables xClientTransactionId for SearchTimeline and other protected endpoints.
 * Logs telemetry for diagnosing auth and API issues.
 */
export async function createScraper(): Promise<Scraper> {
  const scraperStart = Date.now();

  if (!fs.existsSync(config.authPath)) {
    throw new Error('X authentication not configured. Run /x-integration to complete login.');
  }

  const rawCookies = await loadCookies();
  const cookieLoadMs = Date.now() - scraperStart;

  const scraper = new Scraper({
    experimental: {
      xClientTransactionId: true,
      xpff: true,
    },
  });
  await applyCookies(scraper, rawCookies);

  // Verify authentication
  const loggedIn = await scraper.isLoggedIn();
  const authCheckMs = Date.now() - scraperStart;

  if (!loggedIn) {
    console.error(`[x-scraper] Auth check failed after ${authCheckMs}ms (${rawCookies.length} cookies loaded in ${cookieLoadMs}ms), re-extracting from browser`);
    // Try re-extracting cookies from browser (cache may be stale)
    const freshCookies = await extractCookiesFromBrowser();
    await scraper.clearCookies();
    await applyCookies(scraper, freshCookies);

    const retryLoggedIn = await scraper.isLoggedIn();
    const totalMs = Date.now() - scraperStart;
    if (!retryLoggedIn) {
      console.error(`[x-scraper] Auth retry also failed after ${totalMs}ms`);
      throw new Error('Not logged in to X. Cookies may be expired. Please re-authenticate via /x-integration setup.');
    }
    console.error(`[x-scraper] Auth recovered with fresh cookies (${totalMs}ms total)`);
  }

  return scraper;
}

/**
 * Force refresh cookies from browser profile (useful after re-authentication).
 */
export async function refreshCookies(): Promise<void> {
  // Delete cache to force re-extraction
  if (fs.existsSync(COOKIES_CACHE_PATH)) {
    fs.unlinkSync(COOKIES_CACHE_PATH);
  }
  await extractCookiesFromBrowser();
}
