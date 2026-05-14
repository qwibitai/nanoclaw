#!/usr/bin/env pnpm exec tsx
/**
 * X unlike — remove your like from a tweet.
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function unlikeTweet(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    if (await article.locator(X_SELECTORS.like).isVisible().catch(() => false)) {
      return { success: true, message: 'Not liked (no-op).' };
    }
    const btn = article.locator(X_SELECTORS.unlike);
    await btn.waitFor({ timeout: config.timeouts.elementWait });
    await btn.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);
    if (await article.locator(X_SELECTORS.like).isVisible().catch(() => false)) {
      return { success: true, message: 'Unliked.' };
    }
    await captureFailure(nav.page, 'unlike-no-verify');
    return { success: false, message: 'Click registered but like-state not visible — verify manually.' };
  } catch (err) {
    return { success: false, message: `unlike error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(unlikeTweet);
