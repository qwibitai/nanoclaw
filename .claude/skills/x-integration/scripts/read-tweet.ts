#!/usr/bin/env pnpm exec tsx
/**
 * X read-tweet — fetch a single tweet by URL or ID.
 *
 * Reads JSON from stdin: { tweetUrl: string }.
 * Returns ScriptResult with renderTweet(t) in `message` and the parsed
 * tweet object in `data` for any downstream tool that wants structured.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { extractTweetId } from '../lib/browser.js';
import { parseTweetCard, renderTweet } from '../lib/extract.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function readTweet(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    const id = extractTweetId(input.tweetUrl);
    const url = id ? X_URLS.tweetById(id) : input.tweetUrl;
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const article = page.locator(X_SELECTORS.tweet).first();
    const exists = await article.isVisible().catch(() => false);
    if (!exists) {
      await captureFailure(page, 'read-tweet-not-found');
      return { success: false, message: 'Tweet not found (deleted, private, or URL invalid).' };
    }

    const tweet = await parseTweetCard(article);
    return { success: true, message: renderTweet(tweet), data: tweet };
  } catch (err) {
    await captureFailure(page, 'read-tweet-error');
    return { success: false, message: `read-tweet error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readTweet);
