#!/usr/bin/env pnpm exec tsx
/**
 * X unretweet — undo your retweet.
 *
 * Flow: click unretweet button → menu opens → click "Undo repost".
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string }

async function unretweet(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    if (await article.locator(X_SELECTORS.retweet).isVisible().catch(() => false)) {
      return { success: true, message: 'Not retweeted (no-op).' };
    }
    const urtBtn = article.locator(X_SELECTORS.unretweet);
    await urtBtn.waitFor({ timeout: config.timeouts.elementWait });
    await urtBtn.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    const confirm = nav.page.locator(X_SELECTORS.unretweetConfirm);
    await confirm.waitFor({ timeout: config.timeouts.elementWait });
    await confirm.click();
    await nav.page.waitForTimeout(config.timeouts.afterSubmit);

    if (await article.locator(X_SELECTORS.retweet).isVisible().catch(() => false)) {
      return { success: true, message: 'Unretweeted.' };
    }
    await captureFailure(nav.page, 'unretweet-no-verify');
    return { success: false, message: 'Click sequence completed but retweet-state not visible — verify manually.' };
  } catch (err) {
    return { success: false, message: `unretweet error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(unretweet);
