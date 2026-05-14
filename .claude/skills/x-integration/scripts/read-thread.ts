#!/usr/bin/env pnpm exec tsx
/**
 * X read-thread — fetch a tweet plus its top replies.
 *
 * X's thread UI: opening a tweet's permalink shows the parent tweet
 * (first article on page) followed by its replies in subsequent
 * articles. We collect all visible articles up to `limit`, mark the
 * first one as the root, the rest as replies.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure, extractTweetId } from '../lib/browser.js';
import { collectTweets, renderTweet, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { tweetUrl: string; limit?: number }

async function readThread(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    const id = extractTweetId(input.tweetUrl);
    const url = id ? X_URLS.tweetById(id) : input.tweetUrl;
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit);
    if (tweets.length === 0) {
      await captureFailure(page, 'read-thread-empty');
      return { success: false, message: 'Thread page produced no tweets — may have failed to load.' };
    }

    const root = tweets[0];
    const replies = tweets.slice(1);
    const header = `Thread root:\n\n${renderTweet(root)}\n\n=== ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} ===`;
    return {
      success: true,
      message: replies.length > 0 ? `${header}\n\n${renderTweetList(replies, '').trim()}` : header,
      data: { root, replies },
    };
  } catch (err) {
    await captureFailure(page, 'read-thread-error');
    return { success: false, message: `read-thread error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readThread);
