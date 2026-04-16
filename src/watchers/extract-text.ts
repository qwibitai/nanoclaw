import type { BrowserSessionManager } from '../browser/session-manager.js';
import { logger } from '../logger.js';

/**
 * Create an extract function bound to a BrowserSessionManager and groupId.
 * The returned function navigates to a URL, reads textContent from a CSS
 * selector, then closes the page. Suitable as the `extract` parameter for
 * `evaluateWatcher()`.
 */
export function createExtractFn(
  sessionManager: BrowserSessionManager,
  groupId: string,
): (url: string, selector: string) => Promise<string> {
  return async (url: string, selector: string): Promise<string> => {
    const ctx = await sessionManager.acquireContext(groupId);
    const page = await ctx.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const text = await page.textContent(selector, { timeout: 10_000 });
      return text ?? '';
    } finally {
      await page.close().catch((err: unknown) => {
        logger.warn({ err, url }, 'Failed to close watcher page');
      });
    }
  };
}
