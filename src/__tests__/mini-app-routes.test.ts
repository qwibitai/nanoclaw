import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createMiniAppServer } from '../mini-app/server.js';

describe('Mini App extended routes', () => {
  function setup() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE task_detail_state (
        task_id TEXT PRIMARY KEY, title TEXT, status TEXT,
        steps_json TEXT DEFAULT '[]', log_json TEXT DEFAULT '[]', started_at TEXT
      );
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY, account TEXT, original_body TEXT,
        enriched_at TEXT, expires_at TEXT
      );
    `);

    const mockGmailOps = {
      getMessageBody: vi.fn().mockResolvedValue('Full email body for test'),
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
    };
    const mockDraftWatcher = {
      revert: vi.fn().mockResolvedValue(true),
    };

    const app = createMiniAppServer({
      port: 0,
      db,
      gmailOps: mockGmailOps as any,
      draftWatcher: mockDraftWatcher as any,
    });

    return { app, db, mockGmailOps, mockDraftWatcher };
  }

  it('GET /email/:emailId returns HTML with fetched body', async () => {
    const { app, mockGmailOps } = setup();
    const res = await request(app).get('/email/msg123?account=personal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Full email body for test');
    expect(mockGmailOps.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg123',
    );
  });

  it('GET /draft-diff/:draftId shows diff view', async () => {
    const { app, db } = setup();
    db.prepare(
      `INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'd1',
      'personal',
      'Original draft text',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
    );

    const res = await request(app).get('/draft-diff/d1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Original draft text');
  });

  it('POST /api/draft/:draftId/revert calls draftWatcher.revert', async () => {
    const { app, mockDraftWatcher } = setup();
    const res = await request(app).post('/api/draft/d1/revert');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockDraftWatcher.revert).toHaveBeenCalledWith('d1');
  });

  it('GET /draft-diff/:draftId returns 404 if not found', async () => {
    const { app } = setup();
    const res = await request(app).get('/draft-diff/nonexistent');
    expect(res.status).toBe(404);
  });
});
