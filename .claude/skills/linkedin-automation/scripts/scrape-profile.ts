/**
 * LinkedIn Automation — Scrape a Single Profile
 *
 * Extracts full profile data and saves it to Notion.
 * Input: { profileUrl: string, campaign?: string, source?: string }
 * Output: { success: boolean, message: string, data?: ProfileData }
 */

import {
  runScript, getBrowserContext, navigateToProfile,
  extractProfileData, incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';
import { upsertLead } from '../lib/notion.js';

runScript<{ profileUrl: string; campaign?: string; source?: string }>(async ({ profileUrl, campaign, source }) => {
  if (!profileUrl) return { success: false, message: 'profileUrl is required' };

  if (!checkLimit('profileViews', 'maxProfileViewsPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily profile view limit reached (${counts.profileViews}/${config.limits.maxProfileViewsPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToProfile(context, profileUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    await randomDelay(1500, 3000);
    const profile = await extractProfileData(page, profileUrl);
    incrementCount('profileViews');

    // Save to Notion
    await upsertLead({
      name:       profile.name,
      profileUrl: profile.profileUrl,
      title:      profile.headline,
      company:    profile.company,
      location:   profile.location,
      email:      profile.email,
      about:      profile.about,
      source:     source || 'Manual',
      status:     'Visited',
      campaign:   campaign,
    });

    return {
      success: true,
      message: `Scraped and saved profile: ${profile.name} (${profile.headline})`,
      data: profile,
    };
  } finally {
    await context.close();
  }
});
