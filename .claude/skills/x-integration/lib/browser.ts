/**
 * X Integration - Shared utilities
 * Used by all X scripts
 */

import { chromium, BrowserContext, Page } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { X_SELECTORS } from './locators.js';

export { config };

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * Read input from stdin
 */
export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Write result to stdout
 */
export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Clean up browser lock files
 */
export function cleanupLockFiles(): void {
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

/**
 * Validate tweet/reply content
 */
export function validateContent(content: string | undefined, type = 'Tweet'): ScriptResult | null {
  if (!content || content.length === 0) {
    return { success: false, message: `${type} content cannot be empty` };
  }
  if (content.length > config.limits.tweetMaxLength) {
    return { success: false, message: `${type} exceeds ${config.limits.tweetMaxLength} character limit (current: ${content.length})` };
  }
  return null; // Valid
}

/**
 * Validate DM content (10k char cap, much higher than tweet).
 */
export function validateDmContent(content: string | undefined): ScriptResult | null {
  if (!content || content.length === 0) {
    return { success: false, message: 'DM content cannot be empty' };
  }
  if (content.length > config.limits.dmMaxLength) {
    return { success: false, message: `DM exceeds ${config.limits.dmMaxLength} character limit (current: ${content.length})` };
  }
  return null;
}

/**
 * Verify the page is in a logged-in state. Side-nav account switcher is
 * the canonical "you are logged in" element on every X page after the
 * initial load. If it's missing AND the login form is present, the
 * session has aged out and the user must re-run setup.
 */
export async function ensureLoggedIn(page: Page): Promise<ScriptResult | null> {
  const switcher = await page.locator(X_SELECTORS.accountSwitcher).first().isVisible().catch(() => false);
  if (switcher) return null;
  const loginForm = await page.locator(X_SELECTORS.loginUsernameInput).first().isVisible().catch(() => false);
  if (loginForm) {
    return { success: false, message: 'X login expired. Re-run interactive setup: pnpm exec tsx --env-file=.env .claude/skills/x-integration/scripts/setup.ts' };
  }
  // Neither marker visible — could be a transient load issue. Wait a beat and retry once.
  await page.waitForTimeout(2000);
  const switcherRetry = await page.locator(X_SELECTORS.accountSwitcher).first().isVisible().catch(() => false);
  if (switcherRetry) return null;
  return { success: false, message: 'X login state could not be verified (account-switcher missing). Page may have failed to load — retry, or re-run setup.' };
}

/**
 * On error, dump a screenshot + DOM snapshot to logs/x-failures/ for
 * post-mortem. The agent never sees this — it's host-side debug aid for
 * Scott when a selector breaks.
 */
export async function captureFailure(page: Page, label: string): Promise<string> {
  try {
    fs.mkdirSync(config.failureDumpDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(config.failureDumpDir, `${stamp}-${label}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(`${base}.html`, html);
    return base;
  } catch {
    return '';
  }
}

/**
 * Get browser context with persistent profile
 */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (!fs.existsSync(config.authPath)) {
    throw new Error('X authentication not configured. Run /x-integration to complete login.');
  }

  cleanupLockFiles();

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: false,
    viewport: config.viewport,
    args: config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  return context;
}

/**
 * Extract tweet ID from URL or raw ID
 */
export function extractTweetId(input: string): string | null {
  const urlMatch = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

/**
 * Navigate to a tweet page
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
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const exists = await page.locator('article[data-testid="tweet"]').first().isVisible().catch(() => false);
    if (!exists) {
      return { page, success: false, error: 'Tweet not found. It may have been deleted or the URL is invalid.' };
    }

    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Run script with error handling
 */
export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }
}
