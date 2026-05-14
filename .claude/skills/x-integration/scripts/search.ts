#!/usr/bin/env pnpm exec tsx
/**
 * X search — fetch tweets matching a query.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { query: string; latest?: boolean; limit?: number }

async function search(input: Input): Promise<ScriptResult> {
  if (!input.query) return { success: false, message: 'query required.' };
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.search(input.query, !!input.latest), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit);
    const sortLabel = input.latest ? 'Latest' : 'Top';
    return {
      success: true,
      message: renderTweetList(tweets, `Search "${input.query}" (${sortLabel}) — ${tweets.length} tweet${tweets.length === 1 ? '' : 's'}:`),
      data: tweets,
    };
  } catch (err) {
    await captureFailure(page, 'search-error');
    return { success: false, message: `search error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(search);
