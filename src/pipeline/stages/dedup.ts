/**
 * Shared dedup stage — prevents processing duplicate messages.
 * Uses an in-memory Set as a hot cache with SQLite as persistent backing store.
 * Survives restarts: messages seen before won't be reprocessed.
 */
import { RATE_LIMITS } from '../../filters.js';
import { logger } from '../../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

// Lazy-load DB functions; graceful fallback if unavailable
let dbHasMessageId: ((id: string) => boolean) | undefined;
let dbRecordMessageId: ((id: string) => void) | undefined;

try {
  const dbMod = await import('../../db.js');
  dbHasMessageId = dbMod.hasMessageId;
  dbRecordMessageId = dbMod.recordMessageId;
} catch {
  logger.warn('Dedup DB unavailable — running memory-only dedup (no persistence across restarts)');
}

export class DedupStage implements InboundStage {
  name = 'dedup';

  private seen = new Set<string>();
  private maxSize = RATE_LIMITS.dedup.maxCache;

  process(msg: InboundMessage): StageVerdict {
    // Fast path: in-memory cache
    if (this.seen.has(msg.id)) {
      return { action: 'reject', reason: 'duplicate message ID' };
    }

    // Always check persistent DB (memory set is a fast-path cache, not source of truth)
    if (dbHasMessageId) {
      if (dbHasMessageId(msg.id)) {
        this.seen.add(msg.id);
        return { action: 'reject', reason: 'duplicate message ID (persisted)' };
      }
    }

    // New message — record in both layers
    this.seen.add(msg.id);
    try {
      dbRecordMessageId?.(msg.id);
    } catch {
      // DB write failure is non-fatal; memory dedup still works
    }

    // Prune when cache exceeds limit — keep the newer half
    if (this.seen.size > this.maxSize) {
      const entries = [...this.seen];
      this.seen = new Set(entries.slice(-Math.floor(this.maxSize / 2)));
    }

    return { action: 'pass' };
  }
}
