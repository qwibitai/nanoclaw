#!/usr/bin/env pnpm exec tsx
/**
 * X bookmark — bookmark a tweet.
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function bookmark(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    if (await article.locator(X_SELECTORS.removeBookmark).isVisible().catch(() => false)) {
      return { success: true, message: 'Already bookmarked (no-op).' };
    }
    const btn = article.locator(X_SELECTORS.bookmark);
    await btn.waitFor({ timeout: config.timeouts.elementWait });
    await btn.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);
    if (await article.locator(X_SELECTORS.removeBookmark).isVisible().catch(() => false)) {
      return { success: true, message: 'Bookmarked.' };
    }
    await captureFailure(nav.page, 'bookmark-no-verify');
    return { success: false, message: 'Click registered but remove-bookmark state not visible — verify manually.' };
  } catch (err) {
    return { success: false, message: `bookmark error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(bookmark);
