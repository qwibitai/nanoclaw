#!/usr/bin/env pnpm exec tsx
/**
 * X quote — quote-tweet with comment, optional media + schedule.
 *
 * Flow: navigate to tweet → click retweet icon → click "Quote" in
 * popup → modal opens with the source tweet attached → fill comment →
 * optional media → optional schedule → click modal "Post" button.
 */

import fs from 'fs';
import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure, validateContent } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string; comment: string; media?: string[]; scheduleAt?: string | null }

async function quote(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };
  const validation = validateContent(input.comment, 'Quote comment');
  if (validation) return validation;

  const media = input.media ?? [];
  if (media.length > config.limits.mediaMaxPerTweet) {
    return { success: false, message: `media: maximum ${config.limits.mediaMaxPerTweet} images per quote tweet.` };
  }
  for (const p of media) {
    if (!fs.existsSync(p)) return { success: false, message: `media file not found: ${p}` };
  }

  const scheduleAt = input.scheduleAt ? new Date(input.scheduleAt) : null;
  if (scheduleAt && (isNaN(scheduleAt.getTime()) || scheduleAt.getTime() < Date.now())) {
    return { success: false, message: `scheduleAt must be a future ISO timestamp (got "${input.scheduleAt}").` };
  }

  const context = await getBrowserContext();
  try {
    const nav = await navigateToTweet(context, input.tweetUrl);
    if (!nav.success) return { success: false, message: nav.error || 'Navigation failed.' };
    const auth = await ensureLoggedIn(nav.page);
    if (auth) return auth;

    const article = nav.page.locator(X_SELECTORS.tweet).first();
    // Open the retweet popup, then choose "Quote" rather than retweetConfirm.
    await article.locator(X_SELECTORS.retweet).first().click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // The "Quote" entry has its own data-testid in modern X: "quoteOption".
    // Fall back to text-match if the testid changes.
    const quoteOption = nav.page.locator('[data-testid="quoteOption"], div[role="menuitem"]:has-text("Quote")').first();
    await quoteOption.waitFor({ timeout: config.timeouts.elementWait });
    await quoteOption.click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    const textarea = nav.page.locator(X_SELECTORS.tweetTextarea);
    await textarea.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await textarea.fill(input.comment);
    await nav.page.waitForTimeout(config.timeouts.afterFill);

    if (media.length > 0) {
      const fileInput = nav.page.locator(X_SELECTORS.fileInput).first();
      await fileInput.waitFor({ state: 'attached', timeout: config.timeouts.elementWait });
      await fileInput.setInputFiles(media);
      await nav.page.waitForTimeout(3000 + media.length * 1000);
    }

    if (scheduleAt) {
      const scheduleBtn = nav.page.locator(X_SELECTORS.scheduleIconButton);
      await scheduleBtn.waitFor({ timeout: config.timeouts.elementWait });
      await scheduleBtn.click();
      await nav.page.waitForTimeout(config.timeouts.afterClick);

      const yyyy = scheduleAt.getFullYear();
      const mm = String(scheduleAt.getMonth() + 1).padStart(2, '0');
      const dd = String(scheduleAt.getDate()).padStart(2, '0');
      const HH = String(scheduleAt.getHours()).padStart(2, '0');
      const MM = String(scheduleAt.getMinutes()).padStart(2, '0');
      const dateInput = nav.page.locator('input[type="date"]').first();
      const timeInput = nav.page.locator('input[type="time"]').first();
      if (await dateInput.count()) await dateInput.fill(`${yyyy}-${mm}-${dd}`);
      if (await timeInput.count()) await timeInput.fill(`${HH}:${MM}`);
      await nav.page.waitForTimeout(config.timeouts.afterFill);

      const scheduleConfirm = nav.page.locator(X_SELECTORS.scheduleConfirmButton);
      await scheduleConfirm.waitFor({ timeout: config.timeouts.elementWait });
      await scheduleConfirm.click();
      await nav.page.waitForTimeout(config.timeouts.afterSubmit);
    }

    const submit = nav.page.locator(X_SELECTORS.tweetButtonModal);
    await submit.waitFor({ timeout: config.timeouts.elementWait });
    if ((await submit.getAttribute('aria-disabled')) === 'true') {
      return { success: false, message: 'Post button disabled — comment may be invalid.' };
    }
    await submit.click();
    await nav.page.waitForTimeout(config.timeouts.afterSubmit);

    const headline = scheduleAt
      ? `Quote tweet scheduled for ${scheduleAt.toISOString()}`
      : `Quote tweet posted: ${input.comment.slice(0, 80)}${input.comment.length > 80 ? '…' : ''}`;
    return { success: true, message: headline };
  } catch (err) {
    return { success: false, message: `quote error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(quote);
