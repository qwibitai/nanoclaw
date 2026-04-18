import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DraftEnrichmentWatcher } from '../draft-enrichment.js';
import { EventBus } from '../event-bus.js';
import type { DraftInfo } from '../draft-enrichment.js';

describe('DraftEnrichmentWatcher', () => {
  let bus: EventBus;
  let db: Database.Database;
  let watcher: DraftEnrichmentWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        original_body TEXT NOT NULL,
        enriched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    if (watcher) watcher.stop();
    bus.removeAllListeners();
    db.close();
    vi.useRealTimers();
  });

  it('detects new drafts and emits email.draft.created', async () => {
    const createdHandler = vi.fn();
    bus.on('email.draft.created', createdHandler);

    const mockDraft: DraftInfo = {
      draftId: 'd1',
      threadId: 't1',
      account: 'personal',
      subject: 'Re: Invoice #123',
      body: 'Original draft body',
      createdAt: new Date().toISOString(),
    };

    watcher = new DraftEnrichmentWatcher(bus, db, {
      accounts: ['personal'],
      listRecentDrafts: vi.fn().mockResolvedValue([mockDraft]),
      evaluateEnrichment: vi.fn().mockResolvedValue(null), // no enrichment needed
      updateDraft: vi.fn(),
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(100); // let the immediate poll run

    expect(createdHandler).toHaveBeenCalledTimes(1);
    expect(createdHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'email.draft.created',
        payload: { draftId: 'd1', threadId: 't1', account: 'personal' },
      }),
    );
  });

  it('enriches draft and stores original for revert', async () => {
    const enrichedHandler = vi.fn();
    bus.on('email.draft.enriched', enrichedHandler);

    const mockDraft: DraftInfo = {
      draftId: 'd1',
      threadId: 't1',
      account: 'dev',
      subject: 'Re: Staging request',
      body: 'Original body',
      createdAt: new Date().toISOString(),
    };

    const updateDraft = vi.fn();

    watcher = new DraftEnrichmentWatcher(bus, db, {
      accounts: ['dev'],
      listRecentDrafts: vi.fn().mockResolvedValue([mockDraft]),
      evaluateEnrichment: vi
        .fn()
        .mockResolvedValue('Enriched body with context'),
      updateDraft,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(100);

    // Draft was updated
    expect(updateDraft).toHaveBeenCalledWith(
      'dev',
      'd1',
      'Enriched body with context',
    );

    // Original stored in DB
    const original = db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get('d1') as Record<string, string>;
    expect(original.original_body).toBe('Original body');

    // Event emitted
    expect(enrichedHandler).toHaveBeenCalledTimes(1);
  });

  it('skips already-seen drafts', async () => {
    const createdHandler = vi.fn();
    bus.on('email.draft.created', createdHandler);

    const mockDraft: DraftInfo = {
      draftId: 'd1',
      threadId: 't1',
      account: 'personal',
      subject: 'Test',
      body: 'Body',
      createdAt: new Date().toISOString(),
    };

    const listRecentDrafts = vi.fn().mockResolvedValue([mockDraft]);

    watcher = new DraftEnrichmentWatcher(bus, db, {
      accounts: ['personal'],
      listRecentDrafts,
      evaluateEnrichment: vi.fn().mockResolvedValue(null),
      updateDraft: vi.fn(),
      pollIntervalMs: 5000,
    });

    watcher.start();
    await vi.advanceTimersByTimeAsync(100); // first poll
    await vi.advanceTimersByTimeAsync(5000); // second poll

    // Should only emit once despite two polls
    expect(createdHandler).toHaveBeenCalledTimes(1);
  });

  it('reverts a draft to original', async () => {
    const updateDraft = vi.fn();

    watcher = new DraftEnrichmentWatcher(bus, db, {
      accounts: ['personal'],
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      evaluateEnrichment: vi.fn().mockResolvedValue(null),
      updateDraft,
    });

    // Manually insert an original
    db.prepare(
      'INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'd1',
      'personal',
      'Original body',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
    );

    const reverted = await watcher.revert('d1');
    expect(reverted).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith('personal', 'd1', 'Original body');

    // Original should be deleted after revert
    const row = db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get('d1');
    expect(row).toBeUndefined();
  });

  it('returns false when reverting unknown draft', async () => {
    watcher = new DraftEnrichmentWatcher(bus, db, {
      accounts: ['personal'],
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      evaluateEnrichment: vi.fn().mockResolvedValue(null),
      updateDraft: vi.fn(),
    });

    const reverted = await watcher.revert('nonexistent');
    expect(reverted).toBe(false);
  });
});
