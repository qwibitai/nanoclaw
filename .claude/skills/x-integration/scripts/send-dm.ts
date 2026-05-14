#!/usr/bin/env pnpm exec tsx
/**
 * X send-dm — send a single DM to a user by handle.
 *
 * Strategy: navigate to /messages/compose, type the recipient's handle
 * in the search field, click the first matching user result, click
 * Next, type the message in the DM textarea, click Send.
 *
 * Selectors are LOW confidence (X reshuffles the DM compose modal
 * occasionally) — verify on first user-test failure.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure, validateDmContent } from '../lib/browser.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { handle: string; content: string }

async function sendDm(input: Input): Promise<ScriptResult> {
  if (!input.handle) return { success: false, message: 'handle required.' };
  const handle = input.handle.replace(/^@/, '');
  const validation = validateDmContent(input.content);
  if (validation) return validation;

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.dmCompose, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const search = page.locator(X_SELECTORS.dmComposeSearchInput).first();
    await search.waitFor({ timeout: config.timeouts.elementWait });
    await search.fill(handle);
    await page.waitForTimeout(config.timeouts.afterFill);

    // First search result. X may render multiple — match the one whose
    // visible text contains the exact handle.
    const result = page.locator(X_SELECTORS.dmSearchResultUser).filter({ hasText: new RegExp(`@${handle}\\b`, 'i') }).first();
    if (!(await result.isVisible().catch(() => false))) {
      // Fallback: just take the first result
      const firstResult = page.locator(X_SELECTORS.dmSearchResultUser).first();
      if (!(await firstResult.isVisible().catch(() => false))) {
        await captureFailure(page, 'send-dm-no-results');
        return { success: false, message: `No search results for @${handle}. They may not exist, or may have DMs disabled from non-followers.` };
      }
      await firstResult.click();
    } else {
      await result.click();
    }
    await page.waitForTimeout(config.timeouts.afterClick);

    const next = page.locator(X_SELECTORS.dmComposeNextButton);
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(config.timeouts.afterClick);
    }

    const textInput = page.locator(X_SELECTORS.dmComposerTextInput);
    await textInput.waitFor({ timeout: config.timeouts.elementWait });
    await textInput.fill(input.content);
    await page.waitForTimeout(config.timeouts.afterFill);

    const sendBtn = page.locator(X_SELECTORS.dmComposerSendButton);
    await sendBtn.waitFor({ timeout: config.timeouts.elementWait });
    if ((await sendBtn.getAttribute('aria-disabled')) === 'true') {
      return { success: false, message: 'Send button disabled — message may be invalid or recipient blocked DMs.' };
    }
    await sendBtn.click();
    await page.waitForTimeout(config.timeouts.afterSubmit);

    return { success: true, message: `DM sent to @${handle}.` };
  } catch (err) {
    await captureFailure(page, 'send-dm-error');
    return { success: false, message: `send-dm error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(sendDm);
