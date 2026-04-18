import { eventBus } from '../event-bus.js';
import type { WatcherChangedEvent } from '../events.js';
import { logger } from '../logger.js';

// --- Interfaces ---

export interface WatcherConfig {
  id: string;
  url: string;
  selector: string;
  groupId: string;
  intervalMs: number;
}

export interface WatcherResult {
  changed: boolean;
  newValue: string | null;
  previousValue: string | null;
  error?: string;
}

// --- Core evaluation function ---

/**
 * Evaluates a single watcher by extracting the current value and comparing
 * it against the previously known value. Emits `watcher.changed` via the
 * event bus when a change is detected.
 *
 * @param config        - Watcher configuration
 * @param previousValue - Last known value (null on first run)
 * @param extract       - Injected async function that fetches the current
 *                        value for a given URL and CSS selector
 */
export async function evaluateWatcher(
  config: WatcherConfig,
  previousValue: string | null,
  extract: (url: string, selector: string) => Promise<string>,
): Promise<WatcherResult> {
  let newValue: string | null = null;

  try {
    newValue = await extract(config.url, config.selector);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        watcherId: config.id,
        url: config.url,
        selector: config.selector,
        error,
      },
      'Browser watcher extraction failed',
    );
    return { changed: false, newValue: null, previousValue, error };
  }

  if (newValue === previousValue) {
    logger.debug(
      { watcherId: config.id, value: newValue },
      'Browser watcher: no change detected',
    );
    return { changed: false, newValue, previousValue };
  }

  logger.info(
    { watcherId: config.id, previousValue, newValue },
    'Browser watcher: change detected',
  );

  const event: WatcherChangedEvent = {
    type: 'watcher.changed',
    source: 'browser-watcher',
    groupId: config.groupId,
    timestamp: Date.now(),
    payload: {
      watcherId: config.id,
      url: config.url,
      selector: config.selector,
      previousValue,
      newValue,
      groupId: config.groupId,
    },
  };

  eventBus.emit('watcher.changed', event);

  return { changed: true, newValue, previousValue };
}
