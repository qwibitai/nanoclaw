#!/usr/bin/env pnpm exec tsx
/**
 * X unbookmark — remove a bookmark.
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function unbookmark(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    if (await article.locator(X_SELECTORS.bookmark).isVisible().catch(() => false)) {
      return { success: true, message: 'Not bookmarked (no-op).' };
    }
    const btn = article.locator(X_SELECTORS.removeBookmark);
    await btn.waitFor({ timeout: config.timeouts.elementWait });
    await btn.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);
    if (await article.locator(X_SELECTORS.bookmark).isVisible().catch(() => false)) {
      return { success: true, message: 'Unbookmarked.' };
    }
    await captureFailure(nav.page, 'unbookmark-no-verify');
    return { success: false, message: 'Click registered but bookmark state not visible — verify manually.' };
  } catch (err) {
    return { success: false, message: `unbookmark error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(unbookmark);
