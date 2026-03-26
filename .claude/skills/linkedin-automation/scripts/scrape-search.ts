/**
 * LinkedIn Automation — Scrape LinkedIn Search Results
 *
 * Searches LinkedIn people search, extracts profile data, saves to Notion.
 * Input: { query: string, maxLeads?: number, campaign?: string }
 * Output: { success: boolean, message: string, data?: { count: number, leads: string[] } }
 */

import {
  runScript, getBrowserContext, extractProfileData,
  incrementCount, checkLimit, loadDailyCounts, randomDelay, config
} from '../lib/browser.js';
import { upsertLead } from '../lib/notion.js';

runScript<{ query: string; maxLeads?: number; campaign?: string; connectionsOnly?: boolean }>(async ({ query, maxLeads = 25, campaign, connectionsOnly }) => {
  if (!query?.trim()) return { success: false, message: 'query is required' };

  const limit = Math.min(maxLeads, 100); // Hard cap at 100 per run

  const context = await getBrowserContext();
  try {
    const page = context.pages()[0] || await context.newPage();

    // Build search URL
    const networkFilter = connectionsOnly ? '&network=%5B%22F%22%5D' : '';
    const searchUrl = `${config.urls.search}?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER${networkFilter}`;
    await page.goto(searchUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.delays.afterPageLoad);

    const savedLeads: string[] = [];
    let pageNum = 1;

    // Try multiple selectors in case LinkedIn updates their DOM again
    const RESULT_SELECTORS = [
      '[data-chameleon-result-urn]',
      'div[data-view-name="search-entity-result-universal-template"]',
      'li.reusable-search__result-container',
      'li[class*="reusable-search"]',
      'div[data-view-name="search-entity-result-item"]',
    ];

    let activeResultSelector = config.selectors.searchResultsList;

    while (savedLeads.length < limit) {
      // Try each selector until one yields results
      let results = await page.locator(activeResultSelector).all();
      if (results.length === 0) {
        for (const sel of RESULT_SELECTORS) {
          await page.waitForSelector(sel, { timeout: config.timeouts.secondaryWait }).catch(() => null);
          results = await page.locator(sel).all();
          if (results.length > 0) { activeResultSelector = sel; break; }
        }
      }

      if (results.length === 0) {
        console.error('No search results found on this page');
        break;
      }

      for (const result of results) {
        if (savedLeads.length >= limit) break;

        // Extract basic info from search card
        const linkEl = result.locator('a[href*="/in/"]').first();
        const profileUrl = await linkEl.getAttribute('href').catch(() => null);
        if (!profileUrl) continue;

        const fullUrl = profileUrl.startsWith('http') ? profileUrl : `https://www.linkedin.com${profileUrl}`;
        const cleanUrl = fullUrl.split('?')[0]; // Remove tracking params

        // Name: use span[dir="ltr"] > span[aria-hidden="true"] — LinkedIn now randomises class names
        const name     = await result.locator('span[dir="ltr"] > span[aria-hidden="true"]').first().textContent().catch(() => '') ?? '';
        // Headline: .t-14.t-black.t-normal; Location: .t-14.t-normal without .t-black (2nd subtitle)
        const headline = await result.locator(config.selectors.resultHeadline).first().textContent().catch(() => '') ?? '';
        const location = await result.locator(config.selectors.resultLocation).first().textContent().catch(() => '') ?? '';

        if (!checkLimit('profileViews', 'maxProfileViewsPerDay')) {
          console.error('Daily profile view limit reached during scrape');
          break;
        }

        // Save basic data to Notion immediately
        await upsertLead({
          name:       name.trim(),
          profileUrl: cleanUrl,
          title:      headline.trim(),
          location:   location.trim(),
          source:     'Search',
          status:     connectionsOnly ? 'Connected' : 'New',
          campaign:   campaign,
        });

        incrementCount('profileViews');
        savedLeads.push(name.trim() || cleanUrl);
        await randomDelay(500, 1500);
      }

      if (savedLeads.length >= limit) break;

      // Pagination only renders after scrolling to the bottom
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);

      // Go to next page
      const nextBtn = page.locator(config.selectors.nextPageBtn).first();
      const hasNext = await nextBtn.isEnabled({ timeout: config.timeouts.secondaryWait }).catch(() => false);
      if (!hasNext) break;

      await nextBtn.click();
      pageNum++;
      await page.waitForTimeout(config.delays.afterPageLoad);
      await randomDelay(2000, 5000);
    }

    return {
      success: true,
      message: `Scraped ${savedLeads.length} leads for "${query}" and saved to Notion`,
      data: { count: savedLeads.length, leads: savedLeads },
    };
  } finally {
    await context.close();
  }
});
