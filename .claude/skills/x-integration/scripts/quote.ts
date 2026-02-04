#!/usr/bin/env npx tsx
/**
 * X Integration - Quote Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123","comment":"My thoughts"}' | npx tsx quote.ts
 */

import { getBrowserContext, navigateToTweet, navigateTo } from '../lib/browser.js';
import { runScript, ScriptResult } from '../lib/script.js';
import {
  validateTweetUrl,
  validateContent,
  getFirstTweet,
  clickTweetButton,
  fillDialogAndSubmit,
  captureProfileState,
  verifyNewTweet
} from '../lib/utils.js';
import { config } from '../lib/config.js';

const btn = config.selectors.buttons;

interface QuoteInput {
  tweetUrl: string;
  comment: string;
}

async function quoteTweet(input: QuoteInput): Promise<ScriptResult> {
  const { tweetUrl, comment } = input;

  const urlError = validateTweetUrl(tweetUrl);
  if (urlError) return urlError;

  const validationError = validateContent(comment, 'Comment');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    // Capture profile state before quoting
    const state = await captureProfileState(page);
    if (!state) {
      return { success: false, message: 'Could not find profile link in sidebar' };
    }

    // Navigate back to tweet page
    await navigateTo(page, tweetUrl);

    // Click retweet button to open menu
    const tweet = getFirstTweet(page);
    await clickTweetButton(tweet, `${btn.retweet}, ${btn.unretweet}`, page);

    // Click quote option
    const quoteOption = page.getByRole('menuitem').filter({ hasText: /Quote/i });
    await quoteOption.waitFor({ timeout: config.timeouts.elementWait });
    await quoteOption.click();
    await page.waitForTimeout(config.timeouts.actionDelay);

    // Fill dialog and submit
    const result = await fillDialogAndSubmit({
      page,
      content: comment,
      contentLabel: 'Comment'
    });

    if (!result.success) {
      return { success: false, message: result.error || 'Failed to submit quote' };
    }

    // Verify by comparing profile before/after
    const newUrl = await verifyNewTweet(page, state);

    if (!newUrl) {
      return { success: false, message: 'Quote not posted: profile unchanged after quoting' };
    }

    return { success: true, message: `Quote tweet posted: ${newUrl}` };

  } finally {
    if (context) await context.close();
  }
}

runScript<QuoteInput>(quoteTweet);