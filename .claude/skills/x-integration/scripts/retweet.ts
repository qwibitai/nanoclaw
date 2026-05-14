#!/usr/bin/env pnpm exec tsx
/**
 * X retweet — retweet a tweet (no comment).
 *
 * Flow: click retweet button → menu opens → click "Repost" / confirm.
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function retweet(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    if (await article.locator(X_SELECTORS.unretweet).isVisible().catch(() => false)) {
      return { success: true, message: 'Already retweeted (no-op).' };
    }
    const rtBtn = article.locator(X_SELECTORS.retweet);
    await rtBtn.waitFor({ timeout: config.timeouts.elementWait });
    await rtBtn.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // Confirm in popup
    const confirm = nav.page.locator(X_SELECTORS.retweetConfirm);
    await confirm.waitFor({ timeout: config.timeouts.elementWait });
    await confirm.click();
    await nav.page.waitForTimeout(config.timeouts.afterSubmit);

    if (await article.locator(X_SELECTORS.unretweet).isVisible().catch(() => false)) {
      return { success: true, message: 'Retweeted.' };
    }
    await captureFailure(nav.page, 'retweet-no-verify');
    return { success: false, message: 'Click sequence completed but unretweet-state not visible — verify manually.' };
  } catch (err) {
    return { success: false, message: `retweet error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(retweet);
