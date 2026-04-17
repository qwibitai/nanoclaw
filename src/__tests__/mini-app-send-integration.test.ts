import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { EventBus } from '../event-bus.js';
import type { GmailOps } from '../gmail-ops.js';
import { createMiniAppServer } from '../mini-app/server.js';
import { PendingSendRegistry } from '../mini-app/pending-send.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE draft_originals (
      draft_id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      original_body TEXT NOT NULL,
      enriched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      thread_id TEXT
    );
    CREATE TABLE task_detail_state (
      task_id TEXT PRIMARY KEY, title TEXT, status TEXT,
      steps_json TEXT DEFAULT '[]', log_json TEXT DEFAULT '[]', started_at TEXT
    );
  `);
  return db;
}

function seedDraft(db: Database.Database, draftId: string, account: string) {
  db.prepare(
    `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at, thread_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    draftId,
    account,
    '',
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
    'thread-1',
  );
}

describe('mini-app send flow (integration)', () => {
  let db: Database.Database;
  let gmailOps: GmailOps;
  let eventBus: EventBus;
  let registry: PendingSendRegistry;
  let app: import('express').Express;
  let capturedEvents: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    db = makeDb();
    capturedEvents = [];
    gmailOps = {
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue(''),
      getDraftReplyContext: vi.fn().mockResolvedValue({
        body: 'body',
        incoming: {
          from: 'a@x.com',
          to: 'me@x.com',
          subject: 's',
          date: 'd',
        },
      }),
      sendDraft: vi.fn().mockResolvedValue(undefined),
    };
    eventBus = new EventBus();
    eventBus.on('email.draft.send_failed', (e) => capturedEvents.push(e));
    registry = new PendingSendRegistry();
    app = createMiniAppServer({
      port: 0,
      db,
      gmailOps,
      eventBus,
      pendingSendRegistry: registry,
    });
  });
  afterEach(() => {
    registry.shutdown();
    vi.useRealTimers();
    db.close();
  });

  it('save → send → cancel within window: sendDraft never called', async () => {
    seedDraft(db, 'd1', 'personal');
    await request(app).patch('/api/draft/d1/save').send({ body: 'edited' });
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(9000);
    const cancel = await request(app).post('/api/draft/d1/send/cancel').send();
    expect(cancel.body.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    expect(gmailOps.updateDraft).toHaveBeenCalledWith(
      'personal',
      'd1',
      'edited',
    );
  });

  it('save → send → 10s elapses: sendDraft called once', async () => {
    seedDraft(db, 'd1', 'personal');
    await request(app).patch('/api/draft/d1/save').send({ body: 'edited' });
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gmailOps.sendDraft).toHaveBeenCalledTimes(1);
    expect(gmailOps.sendDraft).toHaveBeenCalledWith('personal', 'd1');
  });

  it('sendDraft failure emits email.draft.send_failed event', async () => {
    seedDraft(db, 'd1', 'personal');
    (gmailOps.sendDraft as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('gmail down'),
    );
    await request(app).post('/api/draft/d1/send').send({});
    await vi.advanceTimersByTimeAsync(10_000);
    // Let microtasks settle (the registry catches the promise rejection asynchronously)
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]).toMatchObject({
      type: 'email.draft.send_failed',
      payload: {
        draftId: 'd1',
        account: 'personal',
        error: 'gmail down',
      },
    });
  });
});
