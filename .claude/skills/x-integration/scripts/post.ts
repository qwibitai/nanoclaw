#!/usr/bin/env npx tsx
/**
 * X Integration - Post Tweet
 * Usage: echo '{"content":"Hello world"}' | npx tsx post.ts
 */

import { getBrowserContext, navigateTo } from '../lib/browser.js';
import { runScript, ScriptResult } from '../lib/script.js';
import {
  checkLoginStatus,
  isButtonDisabled,
  validateContent,
  captureProfileState,
  verifyNewTweet
} from '../lib/utils.js';
import { config } from '../lib/config.js';

const sel = config.selectors;
const btn = sel.buttons;

interface PostInput {
  content: string;
}

async function postTweet(input: PostInput): Promise<ScriptResult> {
  const { content } = input;

  const validationError = validateContent(content, 'Tweet');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await navigateTo(page, 'https://x.com/home');

    const { loggedIn, onLoginPage } = await checkLoginStatus(page);
    if (!loggedIn && onLoginPage) {
      return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
    }

    // Capture profile state before posting
    const state = await captureProfileState(page);
    if (!state) {
      return { success: false, message: 'Could not find profile link in sidebar' };
    }

    // Navigate back to home to compose tweet
    await navigateTo(page, 'https://x.com/home');

    const tweetInput = page.locator(sel.tweetTextarea);
    await tweetInput.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await tweetInput.click();
    await page.waitForTimeout(config.timeouts.shortPause);
    await tweetInput.type(content + ' ');  // Trailing space closes hashtag/mention popups
    await page.waitForTimeout(config.timeouts.actionDelay);

    const postButton = page.locator(btn.postInline);
    await postButton.waitFor({ timeout: config.timeouts.elementWait });

    if (await isButtonDisabled(postButton)) {
      return { success: false, message: 'Post button disabled. Content may be empty or exceed character limit.' };
    }

    await postButton.click({ force: true });
    await page.waitForTimeout(config.timeouts.loadWait);

    // Verify by comparing profile before/after
    const newUrl = await verifyNewTweet(page, state);

    if (!newUrl) {
      return { success: false, message: 'Tweet not posted: profile unchanged after posting' };
    }

    return { success: true, message: `Tweet posted: ${newUrl}` };

  } finally {
    if (context) await context.close();
  }
}

runScript<PostInput>(postTweet);