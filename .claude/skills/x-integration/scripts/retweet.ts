#!/usr/bin/env npx tsx
/**
 * X Integration - Retweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx retweet.ts
 */

import { getBrowserContext, navigateToTweet } from '../lib/browser.js';
import { runScript, ScriptResult } from '../lib/script.js';
import { validateTweetUrl, getFirstTweet, toggleTweetAction } from '../lib/utils.js';
import { config } from '../lib/config.js';

const btn = config.selectors.buttons;

interface RetweetInput {
  tweetUrl: string;
}

async function retweet(input: RetweetInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

  const urlError = validateTweetUrl(tweetUrl);
  if (urlError) return urlError;

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    const tweet = getFirstTweet(page);
    return await toggleTweetAction({
      tweet,
      page,
      doneButtonSelector: btn.unretweet,
      actionButtonSelector: btn.retweet,
      actionName: 'Retweet',
      onAfterClick: async () => {
        const retweetConfirm = page.locator(btn.retweetConfirm);
        await retweetConfirm.waitFor({ timeout: config.timeouts.elementWait });
        await retweetConfirm.click();
        await page.waitForTimeout(config.timeouts.actionDelay);
      }
    });

  } finally {
    if (context) await context.close();
  }
}

runScript<RetweetInput>(retweet);
