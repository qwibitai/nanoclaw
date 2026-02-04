#!/usr/bin/env npx tsx
/**
 * X Integration - Like Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx like.ts
 */

import { getBrowserContext, navigateToTweet } from '../lib/browser.js';
import { runScript, ScriptResult } from '../lib/script.js';
import { validateTweetUrl, getFirstTweet, toggleTweetAction } from '../lib/utils.js';
import { config } from '../lib/config.js';

const btn = config.selectors.buttons;

interface LikeInput {
  tweetUrl: string;
}

async function likeTweet(input: LikeInput): Promise<ScriptResult> {
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
      doneButtonSelector: btn.unlike,
      actionButtonSelector: btn.like,
      actionName: 'Like'
    });

  } finally {
    if (context) await context.close();
  }
}

runScript<LikeInput>(likeTweet);