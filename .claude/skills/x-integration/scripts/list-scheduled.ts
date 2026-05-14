#!/usr/bin/env pnpm exec tsx
/**
 * X list-scheduled — list pending scheduled tweets in X's queue.
 *
 * URL: /compose/post/unsent/scheduled. Each scheduled item renders as
 * a card with the body text and a scheduled-for timestamp. Selectors
 * here are LOW confidence (X may rename the wrapper) — verify on first
 * user-test failure and update lib/locators.ts if needed.
 */

import { getBrowserContext, runScript, config, ScriptResult, ensureLoggedIn, captureFailure } from '../lib/browser.js';
import { X_URLS } from '../lib/locators.js';

interface Input {}

interface ScheduledItem {
  index: number;
  text: string;
  scheduledFor: string;
}

async function listScheduled(_input: Input): Promise<ScriptResult> {
  const context = await getBrowserContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(X_URLS.scheduledTweets, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const auth = await ensureLoggedIn(page);
    if (auth) return auth;

    // Each scheduled card: a clickable row with the tweet text + a "Will
    // send on …" line. We scrape the visible cards, parse text + time.
    const cards = page.locator('[role="button"]').filter({ hasText: /Will send on|Scheduled for/ });
    const count = await cards.count();
    const items: ScheduledItem[] = [];
    for (let i = 0; i < count; i++) {
      const text = ((await cards.nth(i).innerText()) || '').trim();
      if (!text) continue;
      // Heuristic split: last line is usually the schedule meta.
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const metaIdx = lines.findIndex((l) => /Will send on|Scheduled for/i.test(l));
      const tweetText = lines.slice(0, metaIdx === -1 ? lines.length : metaIdx).join(' ');
      const scheduledFor = metaIdx === -1 ? '' : lines.slice(metaIdx).join(' ');
      items.push({ index: i + 1, text: tweetText, scheduledFor });
    }

    if (items.length === 0) {
      return { success: true, message: 'No scheduled tweets in queue.', data: [] };
    }
    const blocks = items.map((it) => `[${it.index}] ${it.scheduledFor}\n  ${it.text.slice(0, 200)}${it.text.length > 200 ? '…' : ''}`);
    return {
      success: true,
      message: `Scheduled tweets (${items.length}):\n\n${blocks.join('\n\n')}`,
      data: items,
    };
  } catch (err) {
    await captureFailure(page, 'list-scheduled-error');
    return { success: false, message: `list-scheduled error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context.close();
  }
}

runScript<Input>(listScheduled);
