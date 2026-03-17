import { EventEmitter } from 'events';

/**
 * Tracks in-progress file downloads per chat, enabling download-aware
 * message coalescing. Channels call start/complete around async downloads;
 * GroupQueue checks hasPending/waitForCompletion before starting containers.
 */
export class DownloadTracker extends EventEmitter {
  private pending = new Map<string, Set<string>>();

  start(chatJid: string, downloadId: string): void {
    let set = this.pending.get(chatJid);
    if (!set) {
      set = new Set();
      this.pending.set(chatJid, set);
    }
    set.add(downloadId);
  }

  complete(chatJid: string, downloadId: string): void {
    const set = this.pending.get(chatJid);
    if (!set) return;
    set.delete(downloadId);
    if (set.size === 0) {
      this.pending.delete(chatJid);
      this.emit('allComplete', chatJid);
    }
  }

  hasPending(chatJid: string): boolean {
    const set = this.pending.get(chatJid);
    return !!set && set.size > 0;
  }

  /**
   * Returns a promise that resolves when all pending downloads for the chat
   * complete, or rejects if timeoutMs elapses first.
   */
  waitForCompletion(chatJid: string, timeoutMs: number): Promise<void> {
    if (!this.hasPending(chatJid)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('allComplete', onComplete);
        reject(new Error('Download wait timed out'));
      }, timeoutMs);

      const onComplete = (jid: string) => {
        if (jid !== chatJid) return;
        clearTimeout(timer);
        this.removeListener('allComplete', onComplete);
        resolve();
      };

      this.on('allComplete', onComplete);

      // Guard against race: complete() may have fired between hasPending()
      // check above and listener registration
      if (!this.hasPending(chatJid)) {
        clearTimeout(timer);
        this.removeListener('allComplete', onComplete);
        resolve();
      }
    });
  }
}
