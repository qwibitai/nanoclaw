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
      expires_at TEXT NOT NULL
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
    `INSERT OR REPLACE INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    draftId,
    account,
    '',
    new Date().toISOString(),
    new Date(Date.now() + 86400000).toISOString(),
  );
}

function makeGmailOpsMock(overrides: Partial<GmailOps> = {}): GmailOps {
  return {
    archiveThread: vi.fn().mockResolvedValue(undefined),
    listRecentDrafts: vi.fn().mockResolvedValue([]),
    updateDraft: vi.fn().mockResolvedValue(undefined),
    getMessageBody: vi.fn().mockResolvedValue(''),
    getDraftReplyContext: vi.fn().mockResolvedValue({
      body: 'current enriched body',
      incoming: {
        from: 'alice@example.com',
        to: 'me@example.com',
        subject: 'Ping',
        date: 'Thu, 16 Apr 2026 18:00:00 -0700',
      },
    }),
    sendDraft: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('mini-app draft send routes', () => {
  let db: Database.Database;
  let gmailOps: GmailOps;
  let eventBus: EventBus;
  let registry: PendingSendRegistry;
  let app: import('express').Express;

  beforeEach(() => {
    vi.useFakeTimers();
    db = makeDb();
    gmailOps = makeGmailOpsMock();
    eventBus = new EventBus();
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

  describe('GET /reply/:draftId', () => {
    it('renders HTML with incoming headers + current body', async () => {
      seedDraft(db, 'd1', 'personal');
      const res = await request(app).get('/reply/d1?account=personal');
      expect(res.status).toBe(200);
      expect(res.text).toContain('alice@example.com');
      expect(res.text).toContain('current enriched body');
    });

    it('renders stub HTML when the draft row is missing', async () => {
      const res = await request(app).get('/reply/missing?account=personal');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Draft no longer exists');
    });
  });

  describe('PATCH /api/draft/:draftId/save', () => {
    it('calls updateDraft and returns ok:true', async () => {
      seedDraft(db, 'd1', 'personal');
      const res = await request(app)
        .patch('/api/draft/d1/save')
        .send({ body: 'new body' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(gmailOps.updateDraft).toHaveBeenCalledWith(
        'personal',
        'd1',
        'new body',
      );
    });

    it('returns 404 DRAFT_NOT_FOUND for missing row', async () => {
      const res = await request(app)
        .patch('/api/draft/missing/save')
        .send({ body: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe('DRAFT_NOT_FOUND');
    });
  });

  describe('POST /api/draft/:draftId/send and /send/cancel', () => {
    it('schedules send and returns sendAt', async () => {
      seedDraft(db, 'd1', 'personal');
      const res = await request(app).post('/api/draft/d1/send').send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.sendAt).toBe('number');
      expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    });

    it('cancels a pending send before fire', async () => {
      seedDraft(db, 'd1', 'personal');
      await request(app).post('/api/draft/d1/send').send({});
      const res = await request(app).post('/api/draft/d1/send/cancel').send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, cancelled: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gmailOps.sendDraft).not.toHaveBeenCalled();
    });

    it('reports cancelled=false if not pending', async () => {
      seedDraft(db, 'd1', 'personal');
      const res = await request(app).post('/api/draft/d1/send/cancel').send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, cancelled: false });
    });

    it('fires sendDraft after 10 seconds', async () => {
      seedDraft(db, 'd1', 'personal');
      await request(app).post('/api/draft/d1/send').send({});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gmailOps.sendDraft).toHaveBeenCalledWith('personal', 'd1');
    });
  });
});
