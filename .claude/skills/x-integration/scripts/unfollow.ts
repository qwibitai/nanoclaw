#!/usr/bin/env pnpm exec tsx
/**
 * X unfollow — unfollow a user. Click unfollow → confirmation sheet
 * → Confirm.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { handle: string }

async function unfollow(input: Input): Promise<ScriptResult> {
  if (!input.handle) return { success: false, message: 'handle required.' };
  const handle = input.handle.replace(/^@/, '');

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.profile(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    if (await page.locator(X_SELECTORS.followButton).isVisible().catch(() => false)) {
      return { success: true, message: `Not following @${handle} (no-op).` };
    }
    const btn = page.locator(X_SELECTORS.unfollowButton);
    await btn.waitFor({ timeout: config.timeouts.elementWait });
    await btn.click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Confirmation sheet
    const confirm = page.locator(X_SELECTORS.confirmationSheetConfirm);
    await confirm.waitFor({ timeout: config.timeouts.elementWait });
    await confirm.click();
    await page.waitForTimeout(config.timeouts.afterSubmit);

    if (await page.locator(X_SELECTORS.followButton).isVisible().catch(() => false)) {
      return { success: true, message: `Unfollowed @${handle}.` };
    }
    await captureFailure(page, 'unfollow-no-verify');
    return { success: false, message: `Click sequence completed but follow-state not visible — verify manually.` };
  } catch (err) {
    return { success: false, message: `unfollow error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(unfollow);
