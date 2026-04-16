import type { EventBus } from './event-bus.js';
import type Database from 'better-sqlite3';
import type { EmailDraftCreatedEvent, EmailDraftEnrichedEvent } from './events.js';
import { logger } from './logger.js';

export interface DraftEnrichmentOpts {
  /** Poll interval in ms (default: 60000 — 1 minute) */
  pollIntervalMs?: number;
  /** Accounts to watch (e.g., ['personal', 'dev']) */
  accounts: string[];
  /** Callback to evaluate if a draft needs enrichment. Returns enriched body or null. */
  evaluateEnrichment: (draft: DraftInfo) => Promise<string | null>;
  /** Callback to update the draft via Gmail API */
  updateDraft: (account: string, draftId: string, newBody: string) => Promise<void>;
  /** Callback to list recent drafts from Gmail API */
  listRecentDrafts: (account: string) => Promise<DraftInfo[]>;
}

export interface DraftInfo {
  draftId: string;
  threadId: string;
  account: string;
  subject: string;
  body: string;
  createdAt: string;
}

export class DraftEnrichmentWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private bus: EventBus;
  private db: Database.Database;
  private opts: Required<DraftEnrichmentOpts>;
  private seenDraftIds = new Set<string>();

  constructor(bus: EventBus, db: Database.Database, opts: DraftEnrichmentOpts) {
    this.bus = bus;
    this.db = db;
    this.opts = { pollIntervalMs: 60_000, ...opts };
  }

  start(): void {
    if (this.intervalId) return;
    logger.info({ accounts: this.opts.accounts }, 'Draft enrichment watcher started');

    // Run immediately, then on interval
    this.poll().catch((err) => logger.error({ err }, 'Draft poll error'));
    this.intervalId = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, 'Draft poll error'));
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    for (const account of this.opts.accounts) {
      try {
        const drafts = await this.opts.listRecentDrafts(account);

        for (const draft of drafts) {
          // Skip already-seen drafts
          if (this.seenDraftIds.has(draft.draftId)) continue;
          this.seenDraftIds.add(draft.draftId);

          // Emit draft created event
          this.bus.emit('email.draft.created', {
            type: 'email.draft.created',
            source: 'draft-watcher',
            timestamp: Date.now(),
            payload: {
              draftId: draft.draftId,
              threadId: draft.threadId,
              account: draft.account,
            },
          } as EmailDraftCreatedEvent);

          // Evaluate enrichment
          const enrichedBody = await this.opts.evaluateEnrichment(draft);
          if (!enrichedBody) continue;

          // Store original for revert
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          this.db
            .prepare(
              `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(draft.draftId, account, draft.body, new Date().toISOString(), expiresAt);

          // Update the draft
          await this.opts.updateDraft(account, draft.draftId, enrichedBody);

          // Emit enriched event
          this.bus.emit('email.draft.enriched', {
            type: 'email.draft.enriched',
            source: 'draft-enrichment',
            timestamp: Date.now(),
            payload: {
              draftId: draft.draftId,
              changes: `Draft enriched for "${draft.subject}"`,
            },
          } as EmailDraftEnrichedEvent);

          logger.info({ draftId: draft.draftId, account, subject: draft.subject }, 'Draft enriched');
        }
      } catch (err) {
        logger.error({ err, account }, 'Failed to poll drafts for account');
      }
    }
  }

  /** Revert a draft to its original body */
  async revert(draftId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as { account: string; original_body: string } | undefined;

    if (!row) return false;

    await this.opts.updateDraft(row.account, draftId, row.original_body);
    this.db.prepare('DELETE FROM draft_originals WHERE draft_id = ?').run(draftId);
    logger.info({ draftId }, 'Draft reverted to original');
    return true;
  }

  /** Clean up expired originals */
  cleanupExpired(): void {
    this.db
      .prepare('DELETE FROM draft_originals WHERE expires_at < ?')
      .run(new Date().toISOString());
  }
}
