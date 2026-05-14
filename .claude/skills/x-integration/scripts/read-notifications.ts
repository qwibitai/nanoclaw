#!/usr/bin/env pnpm exec tsx
/**
 * X read-notifications — fetch the mentions/interactions feed.
 *
 * The notifications page contains a mix of cards: tweets that mention
 * you (which parseTweetCard handles), follow notifications, and
 * like/retweet aggregates (which don't render as <article
 * data-testid="tweet">). We collect tweets via collectTweets and
 * surface them; non-tweet notifications are skipped silently.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { limit?: number }

async function readNotifications(input: Input): Promise<ScriptResult> {
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.notifications, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit);
    return {
      success: true,
      message: renderTweetList(tweets, `Notifications — ${tweets.length} mention/reply${tweets.length === 1 ? '' : 's'} (non-tweet notifications like follows/likes are not shown):`),
      data: tweets,
    };
  } catch (err) {
    await captureFailure(page, 'read-notifications-error');
    return { success: false, message: `read-notifications error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readNotifications);
