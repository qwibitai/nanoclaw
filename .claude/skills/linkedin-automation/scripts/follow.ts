/**
 * LinkedIn Automation — Follow a Person or Company
 *
 * Input: { profileUrl: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';

runScript<{ profileUrl: string }>(async ({ profileUrl }) => {
  if (!profileUrl) return { success: false, message: 'profileUrl is required' };

  if (!checkLimit('follows', 'maxFollowsPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily follow limit reached (${counts.follows}/${config.limits.maxFollowsPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    const followBtn = page.locator(`${config.selectors.followBtn}:visible`).first();
    const isVisible = await followBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!isVisible) {
      // Try "More" menu
      const moreBtn = page.locator('button:visible[aria-label*="More actions"]').first();
      if (await moreBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(config.delays.afterClick);
        const menuFollow = page.locator('div[aria-label*="follow" i]').first();
        if (await menuFollow.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
          await menuFollow.click();
        } else {
          return { success: false, message: 'Follow option not found in menu.' };
        }
      } else {
        return { success: false, message: 'Follow button not found. May already be following.' };
      }
    } else {
      // LinkedIn A/B: some profiles render Follow as <a> with SVG overlay blocking clicks.
      const tagName = await followBtn.evaluate(el => el.tagName.toLowerCase());
      const href = tagName === 'a' ? await followBtn.getAttribute('href') : null;

      if (href) {
        await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(config.delays.afterPageLoad);
      } else {
        await followBtn.click();
      }
    }

    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(1500, 4000);
    incrementCount('follows');

    const name = await page.locator(config.selectors.profileName).first().textContent().catch(() => '') ?? '';
    return { success: true, message: `Now following ${name.trim() || profileUrl}` };
  } finally {
    await context.close();
  }
});
