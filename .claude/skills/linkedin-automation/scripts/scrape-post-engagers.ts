/**
 * LinkedIn Automation — Scrape Post Engagers (Likers / Commenters)
 *
 * Extracts people who reacted to or commented on a LinkedIn post → saves to Notion.
 * Input: { postUrl: string, maxLeads?: number, campaign?: string, type?: "reactions" | "comments" }
 * Output: { success: boolean, message: string, data?: { count: number } }
 */

import {
  runScript, getBrowserContext, navigateToPost,
  incrementCount, checkLimit, randomDelay, config
} from '../lib/browser.js';
import { upsertLead } from '../lib/notion.js';

runScript<{ postUrl: string; maxLeads?: number; campaign?: string; type?: 'reactions' | 'comments' }>(
  async ({ postUrl, maxLeads = 50, campaign, type = 'reactions' }) => {
    if (!postUrl) return { success: false, message: 'postUrl is required' };

    const limit = Math.min(maxLeads, 200);
    const context = await getBrowserContext();

    try {
      const { page, success, error } = await navigateToPost(context, postUrl);
      if (!success) return { success: false, message: error || 'Navigation failed' };

      const savedLeads: string[] = [];

      if (type === 'reactions') {
        // Click on the reactions count to open the list
        const reactionsCount = page.locator('button[aria-label*="reaction"], span.social-counts-reactions__count').first();
        if (!await reactionsCount.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false)) {
          return { success: false, message: 'Reactions count not found on this post.' };
        }

        await reactionsCount.click();
        await page.waitForTimeout(1500);

        // Scroll through the reactions list
        const reactorsList = page.locator(config.selectors.engagedList).first();
        await reactorsList.waitFor({ timeout: config.timeouts.elementWait });

        while (savedLeads.length < limit) {
          const items = await page.locator(config.selectors.engagedItem).all();

          for (const item of items) {
            if (savedLeads.length >= limit) break;

            const linkEl = item.locator('a[href*="/in/"]').first();
            const profileUrl = await linkEl.getAttribute('href').catch(() => null);
            if (!profileUrl) continue;

            const cleanUrl = ('https://www.linkedin.com' + profileUrl.split('?')[0]).replace('https://www.linkedin.comhttps://', 'https://');
            if (savedLeads.includes(cleanUrl)) continue;

            const name     = await item.locator('span[aria-hidden="true"]').first().textContent().catch(() => '') ?? '';
            const headline = await item.locator('span[class*="t-12"], span[class*="subtitle"], span[aria-hidden="true"]:nth-child(2)').first().textContent().catch(() => '') ?? '';

            await upsertLead({
              name:       name.trim() || 'Unknown',
              profileUrl: cleanUrl,
              title:      headline.trim(),
              source:     'Post Reaction',
              status:     'New',
              campaign,
            });

            savedLeads.push(cleanUrl);
            if (checkLimit('profileViews', 'maxProfileViewsPerDay')) incrementCount('profileViews');
          }

          // Scroll down to load more
          await page.locator(config.selectors.engagedList).first().evaluate(el => {
            el.scrollTop += 300;
          });
          await page.waitForTimeout(800);

          // Check if no new items loaded
          const newCount = await page.locator(config.selectors.engagedItem).count();
          if (newCount <= savedLeads.length) break;
        }

      } else {
        // Scrape commenters — scroll through comments
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(1500);

        const commenters = await page.locator('div.comments-comment-item a[href*="/in/"]').all();
        for (const commenter of commenters.slice(0, limit)) {
          const profileUrl = await commenter.getAttribute('href').catch(() => null);
          if (!profileUrl) continue;

          const cleanUrl = `https://www.linkedin.com${profileUrl.split('?')[0]}`;
          if (savedLeads.includes(cleanUrl)) continue;

          const name = await commenter.textContent().catch(() => '') ?? '';

          await upsertLead({
            name:       name.trim() || 'Unknown',
            profileUrl: cleanUrl,
            source:     'Post Comment',
            status:     'New',
            campaign,
          });
          savedLeads.push(cleanUrl);
          await randomDelay(300, 800);
        }
      }

      return {
        success: true,
        message: `Scraped ${savedLeads.length} ${type} from post and saved to Notion`,
        data: { count: savedLeads.length },
      };
    } finally {
      await context.close();
    }
  }
);
