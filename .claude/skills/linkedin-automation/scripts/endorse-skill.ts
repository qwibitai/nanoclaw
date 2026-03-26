/**
 * LinkedIn Automation — Endorse a Skill
 *
 * Input: { profileUrl: string, skill: string }
 * Output: { success: boolean, message: string }
 */

import { runScript, getBrowserContext, navigateToProfile, randomDelay, config } from '../lib/browser.js';

runScript<{ profileUrl: string; skill: string }>(async ({ profileUrl, skill }) => {
  if (!profileUrl) return { success: false, message: 'profileUrl is required' };
  if (!skill?.trim()) return { success: false, message: 'skill is required' };

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Scroll to skills section
    const skillsSection = page.locator(config.selectors.skillsSection).first();
    if (!await skillsSection.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false)) {
      return { success: false, message: 'Skills section not found on this profile.' };
    }
    await skillsSection.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    // Find the specific skill
    const skillLocator = page.locator(`span:has-text("${skill.trim()}")`).first();
    if (!await skillLocator.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
      return { success: false, message: `Skill "${skill}" not found on this profile.` };
    }

    // Find endorse button near that skill
    const endorseBtn = page.locator(`div:has(span:has-text("${skill.trim()}")) button[aria-label*="Endorse"]`).first();
    if (!await endorseBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
      return { success: false, message: `Endorse button for "${skill}" not found. You may have already endorsed it.` };
    }

    await endorseBtn.click();
    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(1500, 3000);

    const name = await page.locator(config.selectors.profileName).first().textContent().catch(() => '') ?? '';
    return { success: true, message: `Endorsed "${skill.trim()}" for ${name.trim() || profileUrl}` };
  } finally {
    await context.close();
  }
});
