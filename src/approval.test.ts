import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalStore } from './approval.js';

describe('ApprovalStore', () => {
  let db: Database.Database;
  let store: ApprovalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ApprovalStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves a pending approval', () => {
    const approval = store.create({
      id: 'apr-001',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet: Hello world',
      details: { content: 'Hello world' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(approval.id).toBe('apr-001');
    expect(approval.status).toBe('pending');

    const retrieved = store.get('apr-001');
    expect(retrieved).toBeDefined();
    expect(retrieved!.category).toBe('x_post');
    expect(retrieved!.summary).toBe('Post tweet: Hello world');
  });

  it('resolves an approval as approved', () => {
    store.create({
      id: 'apr-002',
      category: 'x_reply',
      action: 'reply',
      summary: 'Reply to @user',
      details: { tweetId: '123', content: 'Great post!' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const resolved = store.resolve('apr-002', true, 'whatsapp:matthew');
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe('approved');
    expect(resolved!.respondedBy).toBe('whatsapp:matthew');
  });

  it('resolves an approval as rejected', () => {
    store.create({
      id: 'apr-003',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet',
      details: { content: 'test' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const resolved = store.resolve('apr-003', false, 'telegram:matthew');
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe('rejected');
  });

  it('does not resolve an already-resolved approval', () => {
    store.create({
      id: 'apr-004',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet',
      details: { content: 'test' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    store.resolve('apr-004', true, 'whatsapp:matthew');
    const second = store.resolve('apr-004', false, 'telegram:someone');
    expect(second).toBeUndefined();
  });

  it('expires stale approvals', () => {
    store.create({
      id: 'apr-005',
      category: 'x_post',
      action: 'post',
      summary: 'Expired post',
      details: { content: 'old' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const count = store.expireStale();
    expect(count).toBe(1);

    const expired = store.get('apr-005');
    expect(expired!.status).toBe('expired');
  });

  it('lists pending approvals for a group', () => {
    store.create({
      id: 'apr-006', category: 'x_post', action: 'post', summary: 'A',
      details: {}, groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.create({
      id: 'apr-007', category: 'x_like', action: 'like', summary: 'B',
      details: {}, groupFolder: 'other',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const mainApprovals = store.listPending('main');
    expect(mainApprovals).toHaveLength(1);
    expect(mainApprovals[0].id).toBe('apr-006');

    const allApprovals = store.listPending();
    expect(allApprovals).toHaveLength(2);
  });
});
