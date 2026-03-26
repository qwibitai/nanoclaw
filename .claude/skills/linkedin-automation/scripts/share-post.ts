/**
 * LinkedIn Automation — Share / Repost
 *
 * Input: { postUrl: string, commentary?: string }
 * Output: { success: boolean, message: string }
 */

import { runScript, getBrowserContext, navigateToPost, randomDelay, config } from '../lib/browser.js';

runScript<{ postUrl: string; commentary?: string }>(async ({ postUrl, commentary }) => {
  if (!postUrl) return { success: false, message: 'postUrl is required' };

  const context = await getBrowserContext();
  try {
    const { page, success, error } = await navigateToPost(context, postUrl);
    if (!success) return { success: false, message: error || 'Navigation failed' };

    // Click Share/Repost button
    const shareBtn = page.locator('button[aria-label*="Repost"], button[aria-label*="Share"]').first();
    await shareBtn.waitFor({ timeout: config.timeouts.elementWait });
    await shareBtn.click();
    await page.waitForTimeout(config.delays.afterClick);

    if (commentary?.trim()) {
      // Choose "Repost with your thoughts" option
      const withThoughts = page.locator('button:has-text("Repost with your thoughts"), div:has-text("Add thoughts")').first();
      if (await withThoughts.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        await withThoughts.click();
        await page.waitForTimeout(config.delays.afterClick);

        // Type commentary
        const textArea = page.locator('div.share-box-text div[contenteditable="true"], div[aria-label*="Share"][contenteditable]').first();
        await textArea.waitFor({ timeout: config.timeouts.elementWait });
        await textArea.click();
        for (const char of commentary.trim()) {
          await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
        }
        await page.waitForTimeout(config.delays.afterType);
      }

      // Submit
      const postBtn = page.locator('button[aria-label*="Post"], button:has-text("Post")').last();
      await postBtn.click();
    } else {
      // Direct repost without commentary
      const repostBtn = page.locator('button:has-text("Repost")').first();
      if (await repostBtn.isVisible({ timeout: config.timeouts.secondaryWait }).catch(() => false)) {
        await repostBtn.click();
      }
    }

    await page.waitForTimeout(config.delays.afterClick * 2);
    await randomDelay(2000, 5000);

    return {
      success: true,
      message: `Shared post${commentary ? ' with your commentary' : ' (quick repost)'}: ${postUrl}`,
    };
  } finally {
    await context.close();
  }
});
