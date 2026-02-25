/**
 * Ingestion Queue — Bounded async FIFO for background extraction work.
 *
 * All items are fire-and-forget: errors are logged, never propagated.
 * Used to throttle Gemini API calls for fact extraction and embedding.
 */

import type { Logger } from 'pino';

export interface IngestionQueue {
  enqueue(label: string, work: () => Promise<void>): void;
  drain(): Promise<void>;
  readonly pending: number;
  readonly inflight: number;
}

interface QueueItem {
  label: string;
  work: () => Promise<void>;
}

export function createIngestionQueue(opts: {
  maxConcurrency: number;
  maxDepth: number;
  logger: Logger;
}): IngestionQueue {
  const { maxConcurrency, maxDepth, logger } = opts;
  const items: QueueItem[] = [];
  let running = 0;
  let drainResolvers: Array<() => void> = [];

  function pump(): void {
    while (running < maxConcurrency && items.length > 0) {
      const item = items.shift()!;
      running++;
      item
        .work()
        .catch((err) => {
          logger.warn({ err, label: item.label }, 'Ingestion task failed');
        })
        .finally(() => {
          running--;
          pump();
          if (running === 0 && items.length === 0) {
            for (const resolve of drainResolvers) resolve();
            drainResolvers = [];
          }
        });
    }
  }

  return {
    enqueue(label: string, work: () => Promise<void>): void {
      if (items.length >= maxDepth) {
        // Drop oldest to make room
        const dropped = items.shift()!;
        logger.debug({ dropped: dropped.label }, 'Ingestion queue overflow, dropped oldest');
      }
      items.push({ label, work });
      pump();
    },

    drain(): Promise<void> {
      if (running === 0 && items.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },

    get pending(): number {
      return items.length;
    },

    get inflight(): number {
      return running;
    },
  };
}
