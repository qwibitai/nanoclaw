#!/usr/bin/env pnpm exec tsx
/**
 * X reply — reply to a tweet, optionally with media + native scheduling.
 *
 * Flow: navigate to tweet → click reply icon → modal opens → fill text
 * → optional media → optional schedule → click modal "Reply" button.
 */

import fs from 'fs';
import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult, ensureLoggedIn, captureFailure, validateContent } from '../lib/browser.js';
import { X_SELECTORS } from '../lib/locators.js';

interface Input { tweetUrl: string; content: string; media?: string[]; scheduleAt?: string | null }

async function reply(input: Input): Promise<ScriptResult> {
  if (!input.tweetUrl) return { success: false, message: 'tweetUrl required.' };
  const validation = validateContent(input.content, 'Reply');
  if (validation) return validation;

  const media = input.media ?? [];
  if (media.length > config.limits.mediaMaxPerTweet) {
    return { success: false, message: `media: maximum ${config.limits.mediaMaxPerTweet} images per reply.` };
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
    await article.locator(X_SELECTORS.reply).first().click();
    await nav.page.waitForTimeout(config.timeouts.afterClick);

    // Modal textarea (same testid as inline composer in modal scope)
    const textarea = nav.page.locator(X_SELECTORS.tweetTextarea);
    await textarea.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await textarea.fill(input.content);
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
      return { success: false, message: 'Reply button disabled — content may be invalid.' };
    }
    await submit.click();
    await nav.page.waitForTimeout(config.timeouts.afterSubmit);

    const headline = scheduleAt
      ? `Reply scheduled for ${scheduleAt.toISOString()}`
      : `Reply posted to ${input.tweetUrl}`;
    return { success: true, message: headline };
  } catch (err) {
    return { success: false, message: `reply error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(reply);
