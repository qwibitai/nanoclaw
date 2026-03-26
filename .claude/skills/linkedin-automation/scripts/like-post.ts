/**
 * LinkedIn Automation — Like a Post
 *
 * Input: { postUrl: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToPost,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';

runScript<{ postUrl: string }>(async ({ postUrl }) => {
  if (!postUrl) return { success: false, message: 'postUrl is required' };

  if (!checkLimit('likes', 'maxLikesPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily like limit reached (${counts.likes}/${config.limits.maxLikesPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToPost(context, postUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Find Like button (not already liked)
    const likeBtn = page.locator('button[aria-label*="Like"][aria-pressed="false"]').first();
    const isVisible = await likeBtn.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
    if (!isVisible) {
      const alreadyLiked = await page.locator('button[aria-label*="Like"][aria-pressed="true"]').first().isVisible().catch(() => false);
      if (alreadyLiked) return { success: false, message: 'Post is already liked.' };
      return { success: false, message: 'Like button not found. The post may have been deleted.' };
    }

    await likeBtn.click();
    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(1500, 3500);
    incrementCount('likes');

    return { success: true, message: `Liked post: ${postUrl}` };
  } finally {
    await context.close();
  }
});
