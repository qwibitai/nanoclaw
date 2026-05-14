#!/usr/bin/env pnpm exec tsx
/**
 * X read-dm-inbox — list DM conversations with unread + last-message preview.
 *
 * Does NOT mark anything as read (stays on the inbox page; doesn't
 * open individual threads). Each row is a [data-testid="conversation"]
 * which we parse via lib/extract.parseDmConversation.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { parseDmConversation, renderDmInbox, ParsedDmConversation } from '../lib/extract.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { limit?: number }

async function readDmInbox(input: Input): Promise<ScriptResult> {
  const limit = Math.min(input.limit ?? 20, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.dmInbox, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    const rows = page.locator(X_SELECTORS.dmConversation);
    const count = Math.min(await rows.count(), limit);
    const conversations: ParsedDmConversation[] = [];
    for (let i = 0; i < count; i++) {
      conversations.push(await parseDmConversation(rows.nth(i)));
    }

    return {
      success: true,
      message: renderDmInbox(conversations),
      data: conversations,
    };
  } catch (err) {
    await captureFailure(page, 'read-dm-inbox-error');
    return { success: false, message: `read-dm-inbox error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readDmInbox);
