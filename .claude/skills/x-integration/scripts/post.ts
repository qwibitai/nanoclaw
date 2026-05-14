#!/usr/bin/env pnpm exec tsx
/**
 * X post — publish a tweet, optionally with media + native scheduling.
 *
 * Flow:
 *   1. Navigate to /home (use the inline composer).
 *   2. Click into the tweet textarea, fill content.
 *   3. (Optional) Set <input type="file"> with media paths.
 *   4. (Optional) Click the schedule icon, set date/time, confirm.
 *   5. Click the inline post button (label changes to "Schedule" when
 *      a scheduled time is set).
 */

import fs from 'fs';
import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure, validateContent } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { content: string; media?: string[]; scheduleAt?: string | null }

async function postTweet(input: Input): Promise<ScriptResult> {
  const validation = validateContent(input.content, 'Tweet');
  if (validation) return validation;

  const media = input.media ?? [];
  if (media.length > config.limits.mediaMaxPerTweet) {
    return { success: false, message: `media: maximum ${config.limits.mediaMaxPerTweet} images per tweet.` };
  }
  for (const p of media) {
    if (!fs.existsSync(p)) return { success: false, message: `media file not found: ${p}` };
  }

  const scheduleAt = input.scheduleAt ? new Date(input.scheduleAt) : null;
  if (scheduleAt && (isNaN(scheduleAt.getTime()) || scheduleAt.getTime() < Date.now())) {
    return { success: false, message: `scheduleAt must be a future ISO timestamp (got "${input.scheduleAt}").` };
  }

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.home, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const textarea = page.locator(X_SELECTORS.tweetTextarea);
    await textarea.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await textarea.click();
    await textarea.fill(input.content);
    await page.waitForTimeout(config.timeouts.afterFill);

    // Media: locate the first file input under the composer ancestor.
    if (media.length > 0) {
      const fileInput = page.locator(X_SELECTORS.fileInput).first();
      await fileInput.waitFor({ state: 'attached', timeout: config.timeouts.elementWait });
      await fileInput.setInputFiles(media);
      // X processes media asynchronously — wait for thumbnails to appear.
      await page.waitForTimeout(3000 + media.length * 1000);
    }

    // Schedule (X-native)
    if (scheduleAt) {
      const scheduleBtn = page.locator(X_SELECTORS.scheduleIconButton);
      await scheduleBtn.waitFor({ timeout: config.timeouts.elementWait });
      await scheduleBtn.click();
      await page.waitForTimeout(config.timeouts.afterClick);

      // Use the explicit date/time inputs in the modal. Format: yyyy-mm-dd / HH:MM (24h).
      const yyyy = scheduleAt.getFullYear();
      const mm = String(scheduleAt.getMonth() + 1).padStart(2, '0');
      const dd = String(scheduleAt.getDate()).padStart(2, '0');
      const HH = String(scheduleAt.getHours()).padStart(2, '0');
      const MM = String(scheduleAt.getMinutes()).padStart(2, '0');

      const dateInput = page.locator('input[type="date"]').first();
      const timeInput = page.locator('input[type="time"]').first();
      if (await dateInput.count()) {
        await dateInput.fill(`${yyyy}-${mm}-${dd}`);
      }
      if (await timeInput.count()) {
        await timeInput.fill(`${HH}:${MM}`);
      }
      await page.waitForTimeout(config.timeouts.afterFill);

      const scheduleConfirm = page.locator(X_SELECTORS.scheduleConfirmButton);
      await scheduleConfirm.waitFor({ timeout: config.timeouts.elementWait });
      await scheduleConfirm.click();
      await page.waitForTimeout(config.timeouts.afterSubmit);
    }

    const postBtn = page.locator(X_SELECTORS.tweetButtonInline);
    await postBtn.waitFor({ timeout: config.timeouts.elementWait });
    if ((await postBtn.getAttribute('aria-disabled')) === 'true') {
      return { success: false, message: 'Post button disabled — content may be empty or invalid.' };
    }
    await postBtn.click();
    await page.waitForTimeout(config.timeouts.afterSubmit);

    const headline = scheduleAt
      ? `Tweet scheduled for ${scheduleAt.toISOString()}`
      : `Tweet posted: ${input.content.slice(0, 80)}${input.content.length > 80 ? '…' : ''}`;
    return { success: true, message: headline };
  } catch (err) {
    await captureFailure(page, 'post-error');
    return { success: false, message: `post error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(postTweet);
