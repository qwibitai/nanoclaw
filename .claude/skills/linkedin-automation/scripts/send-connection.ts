/**
 * LinkedIn Automation — Send Connection Request
 *
 * Input: { profileUrl: string, note?: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';
import { updateLeadStatus } from '../lib/notion.js';

/** Tracks whether LinkedIn blocked the note with a Premium paywall. */
let premiumPaywallHit = false;

runScript<{ profileUrl: string; note?: string }>(async ({ profileUrl, note }) => {
  premiumPaywallHit = false;

  if (!profileUrl) return { success: false, message: 'profileUrl is required' };

  if (!checkLimit('connections', 'maxConnectionsPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily connection limit reached (${counts.connections}/${config.limits.maxConnectionsPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Click Connect button — use :visible to skip hidden DOM duplicates
    const connectBtn = page.locator(`${config.selectors.connectBtn}:visible`).first();
    const isVisible = await connectBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);

    if (!isVisible) {
      // May be inside the "More" menu
      const moreBtn = page.locator('button:visible[aria-label*="More actions"]').first();
      if (await moreBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(config.delays.afterClick);
        const menuConnect = page.locator('div[aria-label*="connect" i]').first();
        if (await menuConnect.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
          await menuConnect.click();
        } else {
          return { success: false, message: 'Connect button not found. May already be connected or restricted.' };
        }
      } else {
        return { success: false, message: 'Connect button not found. Already connected or profile is restricted.' };
      }
    } else {
      // LinkedIn A/B tests: some profiles use <a> with href="/preload/custom-invite/..."
      // instead of <button>. An SVG overlay blocks Playwright pointer clicks on these <a>
      // elements. When the button is an <a> with an href, navigate directly to the
      // custom-invite URL instead of trying to click through the overlay.
      const tagName = await connectBtn.evaluate(el => el.tagName.toLowerCase());
      const href = tagName === 'a' ? await connectBtn.getAttribute('href') : null;

      if (href && href.includes('/preload/custom-invite/')) {
        // Navigate directly to the custom-invite page (bypasses SVG overlay)
        const fullUrl = new URL(href, page.url()).toString();
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(config.delays.afterPageLoad);

        await handleCustomInvitePage(page, fullUrl, note);
      } else {
        // Standard <button> click — works for the majority of profiles
        await connectBtn.click();
        await page.waitForTimeout(config.delays.afterClick);
        await handleConnectModal(page, note);
      }
    }

    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(2000, 4000);

    incrementCount('connections');

    try {
      await updateLeadStatus(profileUrl, 'Requested');
    } catch {}

    const profileName = await page.locator(config.selectors.profileName).first().textContent().catch(() => '') ?? '';
    const noteSent = note && !premiumPaywallHit;
    return {
      success: true,
      message: `Connection request sent to ${profileName.trim() || profileUrl}${noteSent ? ' with a personalized note' : ''}${premiumPaywallHit ? ' (note skipped — Premium required for custom notes)' : ''}`,
    };
  } finally {
    await context.close();
  }
});

/**
 * Handle the custom-invite page (/preload/custom-invite/...).
 * This is a standalone page (not a modal) with different DOM than the standard
 * connect modal. LinkedIn's free tier limits custom notes — clicking "Add a note"
 * may trigger a Premium paywall instead of showing a textarea.
 */
async function handleCustomInvitePage(page: import('playwright').Page, inviteUrl: string, note?: string) {
  if (note && note.trim()) {
    const addNoteBtn = page.locator(config.selectors.addNoteBtn).first();
    if (await addNoteBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
      await addNoteBtn.click();
      await page.waitForTimeout(config.delays.afterClick);

      // Check if textarea appeared — LinkedIn may show a Premium paywall instead
      const textarea = page.locator(config.selectors.noteTextarea).first();
      if (await textarea.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        // Textarea available — fill note and send
        await page.fill(config.selectors.noteTextarea, note.trim().slice(0, 300));
        await page.waitForTimeout(config.delays.afterType);
        await page.locator(config.selectors.sendNowBtn).first().click();
        return;
      }

      // Premium paywall hit — dismiss it and re-navigate to send without note
      premiumPaywallHit = true;
      const dismissBtn = page.locator('button[aria-label="Dismiss"]').first();
      if (await dismissBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        await dismissBtn.click();
        await page.waitForTimeout(1000);
      }
      // Re-navigate — dismissing the paywall destroys the invite UI
      await page.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(config.delays.afterPageLoad);
    }
  }

  // Send without a note (either no note requested, or Premium paywall fallback)
  const sendBtn = page.locator(config.selectors.sendWithoutNoteBtn).first();
  await sendBtn.click({ timeout: config.timeouts.elementWait });
}

/** Handle the standard connect modal (appears after clicking a <button> Connect). */
async function handleConnectModal(page: import('playwright').Page, note?: string) {
  if (note && note.trim()) {
    const addNoteBtn = page.locator(config.selectors.addNoteBtn).first();
    if (await addNoteBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
      await addNoteBtn.click();
      await page.waitForTimeout(config.delays.afterClick);
      await page.fill(config.selectors.noteTextarea, note.trim().slice(0, 300));
      await page.waitForTimeout(config.delays.afterType);
      await page.locator(config.selectors.sendNowBtn).first().click();
    } else {
      await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
    }
  } else {
    await page.locator(config.selectors.sendWithoutNoteBtn).first().click();
  }
}
