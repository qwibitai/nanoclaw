#!/usr/bin/env pnpm exec tsx
/**
 * X read-timeline — fetch the user's home timeline (For You / Following).
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { limit?: number }

async function readTimeline(input: Input): Promise<ScriptResult> {
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit);
    return {
      success: true,
      message: renderTweetList(tweets, `Home timeline — ${tweets.length} tweet${tweets.length === 1 ? '' : 's'}:`),
      data: tweets,
    };
  } catch (err) {
    await captureFailure(page, 'read-timeline-error');
    return { success: false, message: `read-timeline error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readTimeline);
