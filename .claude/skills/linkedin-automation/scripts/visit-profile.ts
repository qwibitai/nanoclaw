/**
 * LinkedIn Automation — Visit Profile
 *
 * Navigates to a LinkedIn profile (adds to their "Who viewed your profile").
 * Input: { profileUrl: string }
 * Output: { success: boolean, message: string, data?: { name, headline } }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  extractProfileData, incrementCount, checkLimit, randomDelay
} from '../lib/browser.js';
import { updateLeadStatus } from '../lib/notion.js';

runScript<{ profileUrl: string }>(async ({ profileUrl }) => {
  if (!profileUrl) return { success: false, message: 'profileUrl is required' };

  if (!checkLimit('profileViews', 'maxProfileViewsPerDay')) {
    const counts = (await import('../lib/browser.js')).loadDailyCounts();
    return { success: false, message: `Daily profile view limit reached (${counts.profileViews}/${(await import('../lib/config.js')).config.limits.maxProfileViewsPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    await randomDelay();

    const profile = await extractProfileData(page, profileUrl);
    incrementCount('profileViews');

    // Update Notion if lead exists
    try {
      await updateLeadStatus(profileUrl, 'Visited');
    } catch {}

    return {
      success: true,
      message: `Visited profile: ${profile.name || profileUrl}`,
      data: { name: profile.name, headline: profile.headline },
    };
  } finally {
    await context.close();
  }
});
