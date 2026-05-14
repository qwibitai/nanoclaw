#!/usr/bin/env pnpm exec tsx
/**
 * X cancel-scheduled — remove a scheduled tweet from X's queue.
 *
 * Selection: pass `index` (1-based, from list-scheduled) OR `textMatch`
 * (substring of the tweet text). The script clicks into the card, opens
 * the overflow menu, hits "Delete" / "Discard", and confirms.
 *
 * Selectors are LOW confidence — X reshuffles this UI periodically.
 * Verify on user-test, update lib/locators.ts if needed.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { index?: number | null; textMatch?: string | null }

async function cancelScheduled(input: Input): Promise<ScriptResult> {
  if ((input.index === undefined || input.index === null) && !input.textMatch) {
    return { success: false, message: 'Pass either index (1-based) or textMatch (substring of tweet body).' };
  }

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.scheduledTweets, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const cards = page.locator('[role="button"]').filter({ hasText: /Will send on|Scheduled for/ });
    const count = await cards.count();
    if (count === 0) return { success: false, message: 'No scheduled tweets to cancel.' };

    let target = -1;
    if (input.index !== undefined && input.index !== null) {
      const idx = input.index as number;
      if (idx < 1 || idx > count) {
        return { success: false, message: `index out of range: have ${count} scheduled tweet(s), got ${idx}.` };
      }
      target = idx - 1;
    } else if (input.textMatch) {
      const match = input.textMatch.toLowerCase();
      for (let i = 0; i < count; i++) {
        const text = ((await cards.nth(i).innerText()) || '').toLowerCase();
        if (text.includes(match)) {
          target = i;
          break;
        }
      }
      if (target < 0) {
        return { success: false, message: `No scheduled tweet matched "${input.textMatch}".` };
      }
    }

    // Open the card via "Edit", then in the resulting compose UI hit
    // "Delete" / overflow → discard → confirm.
    await cards.nth(target).click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Look for an explicit "Delete" / "Discard" button. Multiple X
    // releases have different testids — try each.
    const deleteSelectors = [
      '[data-testid="confirmationSheetCancel"]',
      'button:has-text("Delete")',
      'button:has-text("Discard")',
      '[data-testid="unsentTweetsList-DiscardButton"]',
    ];
    let clicked = false;
    for (const sel of deleteSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await captureFailure(page, 'cancel-scheduled-no-delete-btn');
      return { success: false, message: 'Could not find a Delete/Discard button — X UI may have changed. Check logs/x-failures/.' };
    }
    await page.waitForTimeout(config.timeouts.afterClick);

    // Some flows have a confirmation sheet
    const confirm = page.locator(X_SELECTORS.confirmationSheetConfirm).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(config.timeouts.afterSubmit);
    }

    return { success: true, message: `Canceled scheduled tweet #${target + 1}.` };
  } catch (err) {
    await captureFailure(page, 'cancel-scheduled-error');
    return { success: false, message: `cancel-scheduled error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(cancelScheduled);
