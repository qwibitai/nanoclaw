#!/usr/bin/env pnpm exec tsx
/**
 * X delete-tweet — irreversibly remove a tweet from your account.
 *
 * Safety: requires `textMustMatch` (a substring of the actual tweet body).
 * The script reads the live tweet first; if the expected substring isn't
 * present, it refuses to delete. This forces the agent to have actually
 * read the tweet before invoking, and guards against URL hallucinations
 * (wrong tweet id, copy-paste error, agent confusion about which tweet).
 *
 * No approval gate — consistent with the skill's stance ("don't gate per
 * action; wrap if you want approvals"). The text-echo guard is the local
 * safety mechanism that fits the existing trust model for engagement
 * actions like x_post and x_unfollow.
 */
import {
  getBrowserContext,
  navigateToTweet,
  runScript,
  config,
  ScriptResult,
  ensureLoggedIn,
  captureFailure,
} from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input {
  tweetUrl: string;
  textMustMatch: string;
}

const MIN_MATCH_LEN = 5;

async function deleteTweet(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };
  if (!input.textMustMatch || input.textMustMatch.trim().length < MIN_MATCH_LEN) {
    return {
      success: false,
      message: `textMustMatch required (min ${MIN_MATCH_LEN} chars). Pass a distinctive substring of the tweet body to confirm you read it first.`,
    };
  }
  const expected = input.textMustMatch.trim().toLowerCase();

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    await article.waitFor({ timeout: config.timeouts.elementWait });

    // Safety guard: actually read the tweet and verify it matches the caller's expectation.
    const actualText = (await article.locator(X_SELECTORS.tweetText).first().innerText().catch(() => '')).trim();
    if (!actualText) {
      await captureFailure(nav.page, 'delete-tweet-no-body');
      return {
        success: false,
        message: 'Could not read tweet body to verify; refusing to delete without confirmation.',
      };
    }
    if (!actualText.toLowerCase().includes(expected)) {
      return {
        success: false,
        message:
          `Safety guard: actual tweet body does not contain expected substring. ` +
          `Expected: "${input.textMustMatch}". ` +
          `Actual (first 200 chars): "${actualText.slice(0, 200)}${actualText.length > 200 ? '…' : ''}". ` +
          `Refusing to delete. Re-read the tweet to confirm you have the right URL.`,
      };
    }

    // Open the caret menu on this tweet
    const caret = article.locator(X_SELECTORS.caret).first();
    await caret.waitFor({ timeout: config.timeouts.elementWait });
    await caret.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // Find and click the "Delete" menu item
    const menuItems = nav.page.locator(X_SELECTORS.dropdownMenuItem);
    const deleteItem = menuItems.filter({ hasText: /^Delete$/i }).first();
    if (!(await deleteItem.isVisible().catch(() => false))) {
      await captureFailure(nav.page, 'delete-tweet-no-menu-item');
      return {
        success: false,
        message: 'Delete menu item not visible in caret dropdown — either not your tweet, or X UI changed.',
      };
    }
    await deleteItem.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // Confirm in the modal
    const confirm = nav.page.locator(X_SELECTORS.confirmationSheetConfirm).first();
    await confirm.waitFor({ timeout: config.timeouts.elementWait });
    await confirm.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // Verify: the article element should no longer be visible (tweet removed from page).
    if (await article.isVisible().catch(() => false)) {
      await captureFailure(nav.page, 'delete-tweet-still-visible');
      return {
        success: false,
        message: 'Click registered but tweet still visible after confirmation — delete may not have taken effect.',
      };
    }

    const preview = actualText.slice(0, 100) + (actualText.length > 100 ? '…' : '');
    return { success: true, message: `Deleted tweet: "${preview}"` };
  } catch (err) {
    return { success: false, message: `delete-tweet error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(deleteTweet);
