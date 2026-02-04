/**
 * X Integration - Browser context and navigation
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Track current context for cleanup on termination
let currentContext: BrowserContext | null = null;

// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  if (currentContext) {
    await currentContext.close().catch(() => {});
  }
  process.exit(0);
});

/**
 * Clean up browser lock files to prevent "browser already running" errors
 */
function cleanupLockFiles(): void {
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
    }
  }
}

/**
 * Get browser context with persistent profile
 * @param skipAuthCheck - Skip auth file check (for setup script)
 */
export async function getBrowserContext(skipAuthCheck = false): Promise<BrowserContext> {
  if (!skipAuthCheck && !fs.existsSync(config.authPath)) {
    throw new Error('X authentication not configured. Run /x-integration to complete login.');
  }

  cleanupLockFiles();

  currentContext = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: false,
    viewport: config.viewport,
    args: config.chrome.args,
    ignoreDefaultArgs: config.chrome.ignoreDefaultArgs,
  });

  return currentContext;
}

/**
 * Navigate to a URL and wait for page to settle.
 */
export async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.timeouts.loadWait);
}

/**
 * Extract tweet ID from URL or raw ID string
 */
function extractTweetId(input: string): string | null {
  const urlMatch = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

/**
 * Navigate to a tweet page and verify it exists
 */
export async function navigateToTweet(
  context: BrowserContext,
  tweetUrl: string
): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = context.pages()[0] || await context.newPage();

  let url = tweetUrl;
  const tweetId = extractTweetId(tweetUrl);
  if (tweetId && !tweetUrl.startsWith('http')) {
    url = `https://x.com/i/status/${tweetId}`;
  }

  try {
    await navigateTo(page, url);

    const exists = await page.locator(config.selectors.tweet).first().isVisible().catch(() => false);
    if (!exists) {
      return { page, success: false, error: 'Tweet not found. It may have been deleted or the URL is invalid.' };
    }

    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}