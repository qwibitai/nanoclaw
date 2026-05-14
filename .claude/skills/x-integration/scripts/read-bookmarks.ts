#!/usr/bin/env pnpm exec tsx
/**
 * X read-bookmarks — fetch the user's bookmarked tweets, newest first.
 *
 * Pagination: X's bookmarks page is an infinite-scroll list with no
 * native cursor. We fake one by treating the oldest tweet ID from the
 * previous batch as a marker — the next call scrolls past everything
 * up to and including that ID before it starts collecting again.
 * Caller walks full history by chaining: first call without `cursor`,
 * subsequent calls pass `nextCursor` from the prior result until no
 * `nextCursor` is returned.
 */

import { getBrowserContext, runScript, ScriptResult, config, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { collectTweets, renderTweetList } from '../lib/extract.js';
import { X_URLS } from '../lib/locators.js';

interface Input { limit?: number; cursor?: string | null }

/** Hard ceiling for `limit` on this tool. Higher than the global READ_MAX
 *  because bookmark walks benefit from larger batches (each paginated
 *  call has to re-scroll past the cursor anyway). */
const BOOKMARKS_LIMIT_MAX = 100;

/** Scroll budget — enough for a paginated walk that has to skip past
 *  hundreds of already-seen items before collecting fresh ones. Bounded
 *  by the host's 120s script timeout; ~100 rounds × 800ms ≈ 80s of
 *  scrolling, leaving room for parse time. */
const SCROLL_MAX_ROUNDS = 100;

async function readBookmarks(input: Input): Promise<ScriptResult> {
  const limit = Math.min(input.limit ?? 20, BOOKMARKS_LIMIT_MAX);
  const cursor = input.cursor && input.cursor.length > 0 ? input.cursor : undefined;

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.bookmarks, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const tweets = await collectTweets(page, limit, {
      scrollMaxRounds: SCROLL_MAX_ROUNDS,
      skipUntilId: cursor,
    });

    // Heuristic: if we filled the limit, assume more are available and
    // emit a cursor. If we returned fewer than asked, the feed is likely
    // exhausted — drop the cursor so the agent stops.
    const nextCursor = tweets.length === limit && tweets[tweets.length - 1]?.id
      ? tweets[tweets.length - 1].id
      : undefined;

    const header = `Bookmarks${cursor ? ' (continued)' : ''} — ${tweets.length} tweet${tweets.length === 1 ? '' : 's'}:`;
    const cursorLine = nextCursor
      ? `\n\nNEXT_CURSOR: ${nextCursor}\n(More bookmarks available. Call x_read_bookmarks again with cursor=${nextCursor} to fetch the next batch.)`
      : '\n\n(End of bookmarks reached, or all bookmarks since cursor returned.)';

    return {
      success: true,
      message: renderTweetList(tweets, header) + cursorLine,
      data: { tweets, nextCursor: nextCursor ?? null },
    };
  } catch (err) {
    await captureFailure(page, 'read-bookmarks-error');
    return { success: false, message: `read-bookmarks error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readBookmarks);
