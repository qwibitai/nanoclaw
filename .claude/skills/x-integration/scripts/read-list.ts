#!/usr/bin/env pnpm exec tsx
/**
 * X read-list — fetch tweets in any X list (yours or someone else's).
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';

interface Input { listUrl: string; limit?: number }

async function readList(input: Input): Promise<ScriptResult> {
  if (!input.listUrl) return { success: false, message: 'listUrl required.' };
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(input.listUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit);
    if (tweets.length === 0) {
      await captureFailure(page, 'read-list-empty');
      return { success: false, message: `No tweets on list ${input.listUrl} — list may be empty, private, or URL invalid.` };
    }
    return {
      success: true,
      message: renderTweetList(tweets, `List (${input.listUrl}) — ${tweets.length} tweet${tweets.length === 1 ? '' : 's'}:`),
      data: tweets,
    };
  } catch (err) {
    await captureFailure(page, 'read-list-error');
    return { success: false, message: `read-list error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readList);
