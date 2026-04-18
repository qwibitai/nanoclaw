import { logger } from '../logger.js';

export interface PendingSend {
  draftId: string;
  account: string;
  sendAt: number;
  timer: NodeJS.Timeout;
}

export type OnFire = (draftId: string, account: string) => Promise<void>;

export class PendingSendRegistry {
  private pending = new Map<string, PendingSend>();

  schedule(
    draftId: string,
    account: string,
    delayMs: number,
    onFire: OnFire,
  ): { sendAt: number } {
    // Replace any existing timer for this draftId
    this.cancel(draftId);

    const sendAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      // Remove from pending BEFORE firing so cancel() post-fire returns false.
      this.pending.delete(draftId);
      onFire(draftId, account).catch((err) => {
        logger.error({ draftId, account, err }, 'Pending send onFire rejected');
      });
    }, delayMs);

    this.pending.set(draftId, { draftId, account, sendAt, timer });
    return { sendAt };
  }

  cancel(draftId: string): boolean {
    const entry = this.pending.get(draftId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(draftId);
    return true;
  }

  has(draftId: string): boolean {
    return this.pending.has(draftId);
  }

  shutdown(): void {
    const draftIds = Array.from(this.pending.keys());
    if (draftIds.length > 0) {
      logger.warn(
        { pendingCount: draftIds.length, draftIds },
        'Pending send dropped at shutdown',
      );
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
