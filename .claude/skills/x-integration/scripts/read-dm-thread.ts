#!/usr/bin/env pnpm exec tsx
/**
 * X read-dm-thread — read messages in a DM thread by recipient handle.
 *
 * CAVEAT: opening the thread marks unread messages as read on X. This
 * is unavoidable — X's web UI dispatches a read receipt as soon as the
 * thread renders. SKILL.md surfaces this caveat to users.
 *
 * Strategy: open inbox, click the conversation whose row contains
 * "@<handle>", then scrape [data-testid="messageEntry"] elements.
 * Direction (you / them) is inferred from CSS positioning (right-side
 * bubbles are "you").
 */

import type { Locator } from 'playwright-core';
import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { renderDmThread, ParsedDmMessage } from '../lib/extract.js';
import { X_SELECTORS, X_URLS } from '../lib/locators.js';

interface Input { handle: string; limit?: number }

async function parseMessage(entry: Locator): Promise<ParsedDmMessage> {
  let text = '';
  let timestamp: string | null = null;
  let direction: 'you' | 'them' = 'them';

  try {
    text = ((await entry.innerText()) || '').trim();
  } catch {}
  try {
    const timeEl = entry.locator('time').first();
    if (await timeEl.count()) timestamp = (await timeEl.getAttribute('datetime')) || null;
  } catch {}
  // Direction heuristic: X aligns own messages to the right (margin-left auto).
  // Try to infer from a parent's text-align / justify-content.
  try {
    const align = await entry.evaluate((el) => {
      let cur = el as HTMLElement | null;
      for (let i = 0; i < 6 && cur; i++) {
        const cs = window.getComputedStyle(cur);
        if (cs.justifyContent === 'flex-end' || cs.alignItems === 'flex-end') return 'you';
        if (cs.justifyContent === 'flex-start' || cs.alignItems === 'flex-start') return 'them';
        cur = cur.parentElement;
      }
      return 'them';
    });
    direction = align as 'you' | 'them';
  } catch {}

  return { text, timestamp, direction };
}

async function readDmThread(input: Input): Promise<ScriptResult> {
  if (!input.handle) return { success: false, message: 'handle required.' };
  const handle = input.handle.replace(/^@/, '');
  const limit = Math.min(input.limit ?? 30, config.limits.readMax);

  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.dmInbox, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    // Find the row whose visible text contains "@<handle>" (case-insensitive)
    const rows = page.locator(X_SELECTORS.dmConversation);
    const count = await rows.count();
    let target = -1;
    const needle = `@${handle}`.toLowerCase();
    for (let i = 0; i < count; i++) {
      const txt = ((await rows.nth(i).innerText()) || '').toLowerCase();
      if (txt.includes(needle)) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      return { success: false, message: `No DM conversation found with @${handle} in the inbox. They may not have messaged you, or may not be in your inbox cache.` };
    }
    await rows.nth(target).click();
    await page.waitForTimeout(config.timeouts.pageLoad);

    const messageEntries = page.locator(X_SELECTORS.dmMessageEntry);
    const msgCount = Math.min(await messageEntries.count(), limit);
    const messages: ParsedDmMessage[] = [];
    for (let i = 0; i < msgCount; i++) {
      messages.push(await parseMessage(messageEntries.nth(i)));
    }

    return {
      success: true,
      message: renderDmThread(messages, handle),
      data: messages,
    };
  } catch (err) {
    await captureFailure(page, 'read-dm-thread-error');
    return { success: false, message: `read-dm-thread error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(readDmThread);
