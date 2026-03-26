/**
 * LinkedIn Automation — Comment on a Post
 *
 * Input: { postUrl: string, comment: string }
 * Output: { success: boolean, message: string }
 */

import {
  runScript, getBrowserContext, navigateToPost,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';

runScript<{ postUrl: string; comment: string }>(async ({ postUrl, comment }) => {
  if (!postUrl)   return { success: false, message: 'postUrl is required' };
  if (!comment?.trim()) return { success: false, message: 'comment is required' };

  if (!checkLimit('comments', 'maxCommentsPerDay')) {
    const counts = loadDailyCounts();
    return { success: false, message: `Daily comment limit reached (${counts.comments}/${config.limits.maxCommentsPerDay})` };
  }

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToPost(context, postUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Click the "Comment" button to open comment box
    const commentTrigger = page.locator('button[aria-label*="Comment"]').first();
    await commentTrigger.waitFor({ timeout: config.timeouts.elementWait });
    await commentTrigger.click();
    await page.waitForTimeout(config.delays.afterClick * 2);

    // Find the comment input
    const commentInput = page.locator('div.comments-comment-box__form div[contenteditable="true"]').first();
    await commentInput.waitFor({ timeout: config.timeouts.elementWait });
    await commentInput.click();
    await page.waitForTimeout(500);

    // Type comment with human cadence
    for (const char of comment.trim()) {
      await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
    }
    await page.waitForTimeout(config.delays.afterType);

    // Submit comment
    const submitBtn = page.locator(config.selectors.commentSubmitBtn).first();
    await submitBtn.waitFor({ timeout: config.timeouts.elementWait });
    await submitBtn.click();
    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(2000, 5000);

    incrementCount('comments');

    return { success: true, message: `Commented on post: "${comment.trim().slice(0, 50)}${comment.length > 50 ? '...' : ''}"` };
  } finally {
    await context.close();
  }
});
