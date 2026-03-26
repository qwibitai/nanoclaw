/**
 * LinkedIn Automation — Run Outreach Campaign
 *
 * Automated sequence: Visit → Connect (with note) → Message (after acceptance).
 * Reads leads from Notion by status, respects daily limits, reports progress.
 *
 * Input: {
 *   steps: ("visit" | "connect" | "message")[],
 *   connectNote?: string,        // Template: use {name} for personalization
 *   messageText?: string,        // Template: use {name} for personalization
 *   campaign?: string,           // Filter leads by campaign name
 *   fromStatus?: LeadStatus,     // Which leads to process (default: "New")
 *   maxLeads?: number,           // Max leads to process this run (default: 10)
 * }
 * Output: { success: boolean, message: string, data?: { processed, skipped, errors } }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  extractProfileData, incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';
import { getLeadsByStatus, updateLeadStatus, LeadStatus } from '../lib/notion.js';

runScript<{
  steps: string[];
  connectNote?: string;
  messageText?: string;
  campaign?: string;
  fromStatus?: LeadStatus;
  maxLeads?: number;
}>(async ({ steps, connectNote, messageText, campaign, fromStatus = 'New', maxLeads = 10 }) => {
  if (!steps?.length) return { success: false, message: 'steps array is required (visit, connect, message)' };

  const leads = await getLeadsByStatus(fromStatus, campaign);
  if (leads.length === 0) {
    return { success: false, message: `No leads with status "${fromStatus}"${campaign ? ` in campaign "${campaign}"` : ''}` };
  }

  const toProcess = leads.slice(0, maxLeads);
  let processed = 0, skipped = 0, errors = 0;

  const context = await getBrowserContext();
  try {
    for (const lead of toProcess) {
      const name = lead.name?.split(' ')[0] || 'there';
      console.error(`Processing: ${lead.name} (${lead.profileUrl})`);

      // ── VISIT ──────────────────────────────────────────────────────────────
      if (steps.includes('visit')) {
        if (!checkLimit('profileViews', 'maxProfileViewsPerDay')) {
          console.error('Daily profile view limit reached, stopping campaign');
          break;
        }

        const { success, error } = await navigateToProfile(context, lead.profileUrl);
        if (!success) { errors++; console.error(`Visit failed: ${error}`); continue; }

        incrementCount('profileViews');
        await updateLeadStatus(lead.profileUrl, 'Visited');
        await randomDelay(config.delays.minMs, config.delays.maxMs);
      }

      // ── CONNECT ────────────────────────────────────────────────────────────
      if (steps.includes('connect') && (fromStatus === 'New' || fromStatus === 'Visited')) {
        if (!checkLimit('connections', 'maxConnectionsPerDay')) {
          console.error('Daily connection limit reached, stopping campaign');
          break;
        }

        const { page, success, error } = await navigateToProfile(context, lead.profileUrl);
        if (!success) { errors++; console.error(`Navigate for connect failed: ${error}`); continue; }

        const connectBtn = page.locator(`${config.selectors.connectBtn}:visible`).first();
        const visible = await connectBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
        if (!visible) { skipped++; console.error(`No connect button for ${lead.name}`); continue; }

        // LinkedIn A/B: some profiles render Connect as <a> with SVG overlay blocking clicks.
        // Detect <a> and navigate directly to the custom-invite URL.
        const tagName = await connectBtn.evaluate(el => el.tagName.toLowerCase());
        const href = tagName === 'a' ? await connectBtn.getAttribute('href') : null;
        const note = connectNote?.replace('{name}', name).trim().slice(0, 300);

        if (href && href.includes('/preload/custom-invite/')) {
          const fullUrl = new URL(href, page.url()).toString();
          await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(config.delays.afterPageLoad);

          if (note) {
            const addNoteBtn = page.locator(config.selectors.addNoteBtn).first();
            if (await addNoteBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
              await addNoteBtn.click();
              await page.waitForTimeout(config.delays.afterClick);
              // Check if textarea appeared — may hit Premium paywall instead
              const textarea = page.locator(config.selectors.noteTextarea).first();
              if (await textarea.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
                await page.fill(config.selectors.noteTextarea, note);
                await page.waitForTimeout(config.delays.afterType);
                await page.locator(config.selectors.sendNowBtn).first().click();
              } else {
                // Premium paywall — dismiss and re-navigate to send without note
                const dismissBtn = page.locator('button[aria-label="Dismiss"]').first();
                if (await dismissBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
                  await dismissBtn.click();
                  await page.waitForTimeout(1000);
                }
                await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(config.delays.afterPageLoad);
                await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
              }
            } else {
              await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
            }
          } else {
            await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
          }
        } else {
          // Standard <button> click path
          await connectBtn.click();
          await page.waitForTimeout(config.delays.afterClick);

          if (note) {
            const addNoteBtn = page.locator(config.selectors.addNoteBtn).first();
            if (await addNoteBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
              await addNoteBtn.click();
              await page.waitForTimeout(config.delays.afterClick);
              await page.fill(config.selectors.noteTextarea, note);
              await page.waitForTimeout(config.delays.afterType);
              await page.locator(config.selectors.sendNowBtn).first().click();
            } else {
              await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
            }
          } else {
            await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
          }
        }

        await page.waitForTimeout(config.delays.afterClick * 2);
        incrementCount('connections');
        await updateLeadStatus(lead.profileUrl, 'Requested');
        await randomDelay(config.delays.minMs, config.delays.maxMs);
      }

      // ── MESSAGE ────────────────────────────────────────────────────────────
      if (steps.includes('message') && fromStatus === 'Connected') {
        if (!checkLimit('messages', 'maxMessagesPerDay')) {
          console.error('Daily message limit reached, stopping campaign');
          break;
        }

        if (!messageText?.trim()) { skipped++; console.error('messageText required for message step'); continue; }

        const { page, success, error } = await navigateToProfile(context, lead.profileUrl);
        if (!success) { errors++; console.error(`Navigate for message failed: ${error}`); continue; }

        const msgBtn = page.locator(`${config.selectors.messageBtn}:visible`).first();
        if (!await msgBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false)) {
          skipped++; console.error(`No message button for ${lead.name} — not connected?`); continue;
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

        const text = messageText.replace('{name}', name).trim();
        for (const char of text) {
          await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
        }
        await page.waitForTimeout(config.delays.afterType);
        await page.locator(config.selectors.msgSendBtn).first().click();
        await page.waitForTimeout(config.delays.afterClick * 2);

        incrementCount('messages');
        await updateLeadStatus(lead.profileUrl, 'Messaged', { messageSent: text });
        await randomDelay(config.delays.minMs, config.delays.maxMs);
      }

      processed++;
      // Longer pause between leads
      await randomDelay(config.delays.betweenActions, config.delays.betweenActions * 2);
    }

    const counts = loadDailyCounts();
    return {
      success: true,
      message: `Campaign run complete. Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors}. Daily totals — Views: ${counts.profileViews}, Connects: ${counts.connections}, Messages: ${counts.messages}`,
      data: { processed, skipped, errors, dailyCounts: counts },
    };
  } finally {
    await context.close();
  }
});
