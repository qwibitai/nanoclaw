#!/usr/bin/env pnpm exec tsx
/**
 * X read-user — fetch a user's recent tweets from their profile.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { handle: string; limit?: number }

async function readUser(input: Input): Promise<ScriptResult> {
  if (!input.handle) return { success: false, message: 'handle required.' };
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);
  const handle = input.handle.replace(/^@/, '');

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.profile(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    // Profile-not-found pages render with no tweet articles.
    const tweets = await collectTweets(page, limit);
    if (tweets.length === 0) {
      await captureFailure(page, 'read-user-empty');
      return {
        success: false,
        message: `No tweets visible on @${handle}'s profile — account may not exist, be private, or the page failed to load.`,
      };
    }

    return {
      success: true,
      message: renderTweetList(tweets, `@${handle} — ${tweets.length} recent tweet${tweets.length === 1 ? '' : 's'}:`),
      data: tweets,
    };
  } catch (err) {
    await captureFailure(page, 'read-user-error');
    return { success: false, message: `read-user error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readUser);
