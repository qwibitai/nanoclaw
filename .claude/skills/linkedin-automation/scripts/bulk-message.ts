/**
 * LinkedIn Automation — Bulk Message to Connections
 *
 * Sends a personalized message to multiple connected leads from Notion.
 * Input: {
 *   messageText: string,   // Use {name} for first name personalization
 *   campaign?: string,
 *   maxMessages?: number,
 * }
 * Output: { success: boolean, message: string, data?: { sent, skipped, errors } }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';
import { getLeadsByStatus, updateLeadStatus } from '../lib/notion.js';

runScript<{ messageText: string; campaign?: string; maxMessages?: number }>(
  async ({ messageText, campaign, maxMessages = 20 }) => {
    if (!messageText?.trim()) return { success: false, message: 'messageText is required. Use {name} for personalization.' };

    const leads = await getLeadsByStatus('Connected', campaign);
    if (leads.length === 0) {
      return { success: false, message: `No Connected leads found${campaign ? ` in campaign "${campaign}"` : ''}` };
    }

    // Filter to not already messaged
    const toMessage = leads.filter(l => !l.messageSent).slice(0, maxMessages);
    if (toMessage.length === 0) {
      return { success: false, message: 'All connected leads have already been messaged.' };
    }

    let sent = 0, skipped = 0, errors = 0;
    const context = await getBrowserContext();

    try {
      for (const lead of toMessage) {
        if (!checkLimit('messages', 'maxMessagesPerDay')) {
          const counts = loadDailyCounts();
          console.error(`Daily message limit reached (${counts.messages}/${config.limits.maxMessagesPerDay}), stopping`);
          break;
        }

        const firstName = lead.name?.split(' ')[0] || 'there';
        const text = messageText.replace(/{name}/g, firstName).trim();

        const { page, success, error } = await navigateToProfile(context, lead.profileUrl);
        if (!success) { errors++; console.error(`Navigate failed for ${lead.name}: ${error}`); continue; }

        const msgBtn = page.locator(`${config.selectors.messageBtn}:visible`).first();
        if (!await msgBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false)) {
          skipped++;
          console.error(`No message button for ${lead.name}`);
          continue;
        }

        // LinkedIn A/B: some profiles render Message as <a href="/messaging/compose/...">
        // with an SVG overlay blocking clicks. Navigate directly when href exists.
        const msgTagName = await msgBtn.evaluate(el => el.tagName.toLowerCase());
        const msgHref = msgTagName === 'a' ? await msgBtn.getAttribute('href') : null;

        if (msgHref && msgHref.includes('/messaging/compose')) {
          await page.goto(new URL(msgHref, page.url()).toString(), { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(config.delays.afterPageLoad);
        } else {
          await msgBtn.click();
          await page.waitForTimeout(config.delays.afterClick * 2);
        }

        const compose = page.locator(config.selectors.msgCompose).first();
        await compose.waitFor({ timeout: config.timeouts.elementWait });
        await compose.click();

        for (const char of text) {
          await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
        }
        await page.waitForTimeout(config.delays.afterType);

        await page.locator(config.selectors.msgSendBtn).first().click();
        await page.waitForTimeout(config.delays.afterClick * 2);

        incrementCount('messages');
        await updateLeadStatus(lead.profileUrl, 'Messaged', { messageSent: text });
        sent++;

        console.error(`Sent to ${lead.name} (${sent}/${toMessage.length})`);
        await randomDelay(config.delays.minMs, config.delays.maxMs);
      }

      const counts = loadDailyCounts();
      return {
        success: true,
        message: `Bulk message complete. Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}. Today's message total: ${counts.messages}/${config.limits.maxMessagesPerDay}`,
        data: { sent, skipped, errors },
      };
    } finally {
      await context.close();
    }
  }
);
