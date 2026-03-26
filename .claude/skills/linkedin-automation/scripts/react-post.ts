/**
 * LinkedIn Automation — React to a Post
 *
 * Reactions: like, celebrate, support, funny, love, insightful, curious
 * Input: { postUrl: string, reaction: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToPost,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';

const REACTION_LABELS: Record<string, string> = {
  like:       'Like',
  celebrate:  'Celebrate',
  support:    'Support',
  funny:      'Funny',
  love:       'Love',
  insightful: 'Insightful',
  curious:    'Curious',
};

runScript<{ postUrl: string; reaction: string }>(async ({ postUrl, reaction }) => {
  if (!postUrl)    return { success: false, message: 'postUrl is required' };
  if (!reaction)   return { success: false, message: 'reaction is required (like, celebrate, support, funny, love, insightful, curious)' };

  const reactionKey = reaction.toLowerCase().trim();
  const reactionLabel = REACTION_LABELS[reactionKey];
  if (!reactionLabel) {
    return { success: false, message: `Unknown reaction "${reaction}". Use: like, celebrate, support, funny, love, insightful, curious` };
  }

  if (!checkLimit('likes', 'maxLikesPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily like/react limit reached (${counts.likes}/${config.limits.maxLikesPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToPost(context, postUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Hover over Like button to trigger reaction menu
    const likeBtn = page.locator('button[aria-label*="Like"]').first();
    await likeBtn.waitFor({ timeout: config.timeouts.elementWait });
    await likeBtn.hover();
    await page.waitForTimeout(1200); // Wait for reaction popup

    // Click the specific reaction
    const reactionBtn = page.locator(`button[aria-label="${reactionLabel}"]`).first();
    const reactionVisible = await reactionBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false);

    if (!reactionVisible) {
      // Fallback: just click Like
      await likeBtn.click();
      incrementCount('likes');
      return { success: true, message: `Liked post (reaction menu not available, fell back to Like)` };
    }

    await reactionBtn.click();
    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(1500, 3500);
    incrementCount('likes');

    return { success: true, message: `Reacted with "${reactionLabel}" to post: ${postUrl}` };
  } finally {
    await context.close();
  }
});
