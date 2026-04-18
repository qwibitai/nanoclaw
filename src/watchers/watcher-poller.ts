/**
 * Watcher Poller — polling loop that evaluates all enabled watchers.
 *
 * Periodically checks each enabled watcher, skipping those whose interval
 * has not yet elapsed, and persists new values on change.
 */

import { logger } from '../logger.js';

import { evaluateWatcher, type WatcherResult } from './browser-watcher.js';
import { listAllEnabledWatchers, updateWatcherValue } from './watcher-store.js';

type ExtractFn = (url: string, selector: string) => Promise<string>;

let pollerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Poll all enabled watchers, skipping those whose interval has not elapsed.
 * Returns an array of results (one per evaluated watcher).
 */
export async function pollAllWatchers(
  extract: ExtractFn,
): Promise<WatcherResult[]> {
  const watchers = listAllEnabledWatchers();
  const results: WatcherResult[] = [];
  const now = Date.now();

  for (const watcher of watchers) {
    // Skip if the interval has not elapsed since last check
    if (
      watcher.checkedAt !== null &&
      now - watcher.checkedAt < watcher.intervalMs
    ) {
      continue;
    }

    const config = {
      id: watcher.id,
      url: watcher.url,
      selector: watcher.selector,
      groupId: watcher.groupId,
      intervalMs: watcher.intervalMs,
    };

    const result = await evaluateWatcher(config, watcher.lastValue, extract);

    if (result.newValue !== null) {
      updateWatcherValue(watcher.id, result.newValue);
    }

    results.push(result);
  }

  logger.debug(
    { total: watchers.length, evaluated: results.length },
    'Watcher poll complete',
  );

  return results;
}

/**
 * Start a polling loop that calls pollAllWatchers on each tick.
 */
export function startWatcherPoller(
  extract: ExtractFn,
  tickMs: number = 30_000,
): void {
  if (pollerInterval) {
    logger.warn('Watcher poller already running; stopping previous instance');
    stopWatcherPoller();
  }

  pollerInterval = setInterval(() => {
    pollAllWatchers(extract).catch((err) => {
      logger.error({ err }, 'Watcher poller tick failed');
    });
  }, tickMs);

  logger.info({ tickMs }, 'Watcher poller started');
}

/**
 * Stop the polling loop.
 */
export function stopWatcherPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info('Watcher poller stopped');
  }
}
