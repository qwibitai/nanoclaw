#!/usr/bin/env pnpm exec tsx
/**
 * X follow — follow a user. Navigates to their profile, clicks Follow.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { handle: string }

async function follow(input: Input): Promise<ScriptResult> {
  if (!input.handle) return { success: false, message: 'handle required.' };
  const handle = input.handle.replace(/^@/, '');

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.profile(handle), { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    if (await page.locator(X_SELECTORS.unfollowButton).isVisible().catch(() => false)) {
      return { success: true, message: `Already following @${handle} (no-op).` };
    }
    const btn = page.locator(X_SELECTORS.followButton);
    await btn.waitFor({ timeout: config.timeouts.elementWait });
    await btn.click();
    await page.waitForTimeout(config.timeouts.afterClick);
    if (await page.locator(X_SELECTORS.unfollowButton).isVisible().catch(() => false)) {
      return { success: true, message: `Followed @${handle}.` };
    }
    await captureFailure(page, 'follow-no-verify');
    return { success: false, message: `Click registered but unfollow-state not visible — @${handle} may have follow-restrictions on. Verify manually.` };
  } catch (err) {
    return { success: false, message: `follow error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(follow);
