/**
 * LinkedIn Automation — Send Direct Message
 *
 * Can only message 1st-degree connections.
 * Input: { profileUrl: string, message: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config, humanType
} from '../lib/browser.js';
import { updateLeadStatus } from '../lib/notion.js';

runScript<{ profileUrl: string; message: string }>(async ({ profileUrl, message }) => {
  if (!profileUrl) return { success: false, message: 'profileUrl is required' };
  if (!message?.trim()) return { success: false, message: 'message is required' };

  if (!checkLimit('messages', 'maxMessagesPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily message limit reached (${counts.messages}/${config.limits.maxMessagesPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    const msgBtn = page.locator(`${config.selectors.messageBtn}:visible`).first();
    const isVisible = await msgBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!isVisible) {
      return { success: false, message: 'Message button not found. Only 1st-degree connections can be messaged.' };
    }

    // LinkedIn A/B: some profiles render Message as <a href="/messaging/compose/...">
    // with an SVG overlay blocking Playwright clicks. Navigate directly when href exists.
    const tagName = await msgBtn.evaluate(el => el.tagName.toLowerCase());
    const href = tagName === 'a' ? await msgBtn.getAttribute('href') : null;

    if (href && href.includes('/messaging/compose')) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(config.delays.afterPageLoad);
    } else {
      await msgBtn.click();
      await page.waitForTimeout(config.delays.afterClick * 2);
    }

    // Type message in the compose box
    const compose = page.locator(config.selectors.msgCompose).first();
    await compose.waitFor({ timeout: config.timeouts.elementWait });
    await compose.click();
    await page.waitForTimeout(500);

    // Type with human-like cadence
    for (const char of message.trim()) {
      await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
    }
    await page.waitForTimeout(config.delays.afterType);

    // Send
    const sendBtn = page.locator(config.selectors.msgSendBtn).first();
    await sendBtn.click();
    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(2000, 5000);

    incrementCount('messages');

    try {
      await updateLeadStatus(profileUrl, 'Messaged', { messageSent: message.trim() });
    } catch {}

    const name = await page.locator(config.selectors.profileName).first().textContent().catch(() => '') ?? '';
    return { success: true, message: `Message sent to ${name.trim() || profileUrl}` };
  } finally {
    await context.close();
  }
});
