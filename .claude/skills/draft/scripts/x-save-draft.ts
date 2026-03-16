#!/usr/bin/env npx tsx
/**
 * Draft Skill - Save Tweet as X Draft
 * Opens X compose, types the tweet, and saves it as a draft (does NOT publish).
 *
 * Usage: echo '{"content":"My tweet text"}' | npx tsx x-save-draft.ts
 */

import { getBrowserContext, runScript, validateContent, config, ScriptResult } from '../../x-integration/lib/browser.js';

interface SaveDraftInput {
  content: string;
}

async function saveDraft(input: SaveDraftInput): Promise<ScriptResult> {
  const { content } = input;

  const validationError = validateContent(content, 'Tweet draft');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    // Navigate to X compose
    await page.goto('https://x.com/compose/post', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
      }
    }

    // Wait for and fill the tweet input in the compose modal
    const tweetInput = page.locator('[data-testid="tweetTextarea_0"]');
    await tweetInput.waitFor({ timeout: config.timeouts.elementWait * 2 });
    await tweetInput.click();
    await page.waitForTimeout(config.timeouts.afterClick / 2);
    await tweetInput.fill(content);
    await page.waitForTimeout(config.timeouts.afterFill);

    // Verify content was entered
    const inputText = await tweetInput.textContent();
    if (!inputText || inputText.trim().length === 0) {
      return { success: false, message: 'Failed to enter tweet content into compose box' };
    }

    // Close the compose modal to trigger "Save draft?" dialog
    // The close button is typically the first button in the modal toolbar area
    const closeButton = page.locator('[data-testid="app-bar-close"]');
    const closeButtonVisible = await closeButton.isVisible().catch(() => false);

    if (closeButtonVisible) {
      await closeButton.click();
    } else {
      // Fallback: try the generic close/back button in the compose dialog
      const altClose = page.locator('button[aria-label="Close"]').first();
      const altCloseVisible = await altClose.isVisible().catch(() => false);
      if (altCloseVisible) {
        await altClose.click();
      } else {
        // Last resort: press Escape
        await page.keyboard.press('Escape');
      }
    }

    await page.waitForTimeout(config.timeouts.afterClick);

    // Look for the "Save" button in the confirmation dialog
    // X shows a dialog asking "Save this post as a draft?"
    const saveButton = page.locator('[data-testid="confirmationSheetConfirm"]');
    const saveVisible = await saveButton.waitFor({ timeout: config.timeouts.elementWait })
      .then(() => true)
      .catch(() => false);

    if (!saveVisible) {
      // Try alternative selector for the save draft button
      const altSave = page.getByRole('button', { name: /save/i });
      const altSaveVisible = await altSave.isVisible().catch(() => false);
      if (altSaveVisible) {
        await altSave.click();
      } else {
        return { success: false, message: 'Could not find "Save draft" button. X UI may have changed.' };
      }
    } else {
      await saveButton.click();
    }

    await page.waitForTimeout(config.timeouts.afterSubmit);

    return {
      success: true,
      message: `Tweet saved as draft: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<SaveDraftInput>(saveDraft);
