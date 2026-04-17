import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GmailOpsRouter } from '../gmail-ops.js';
import { ArchiveTracker } from '../archive-tracker.js';
import { handleCallback } from '../callback-router.js';
import { classifyAndFormat } from '../router.js';
import { createMiniAppServer } from '../mini-app/server.js';

describe('Agentic UX wiring integration', () => {
  it('full archive flow: classify email → callback archive → confirm → Gmail API', async () => {
    // 1. Classify an email message
    const emailText = `[Email [personal] from Alice <alice@test.com>]\nSubject: Invoice\n\n${'Payment details '.repeat(30)}`;
    const classified = classifyAndFormat(emailText);
    expect(classified.meta.category).toBe('email');

    // 2. Set up archive tracker
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY, thread_id TEXT, account TEXT,
        action_taken TEXT, acted_at TEXT, archived_at TEXT
      );
      CREATE TABLE draft_originals (
        draft_id TEXT PRIMARY KEY, account TEXT, original_body TEXT,
        enriched_at TEXT, expires_at TEXT, thread_id TEXT
      );
      CREATE TABLE task_detail_state (
        task_id TEXT PRIMARY KEY, title TEXT, status TEXT,
        steps_json TEXT DEFAULT '[]', log_json TEXT DEFAULT '[]', started_at TEXT
      );
    `);
    const tracker = new ArchiveTracker(db);
    tracker.recordAction('msg1', 'thread1', 'personal', 'replied');

    // 3. Mock Gmail ops
    const mockGmailOps = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Full body'),
    };

    // 4. Simulate confirm_archive callback
    const mockChannel = {
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
    };

    await handleCallback(
      {
        id: 'q1',
        chatJid: 'telegram:123',
        messageId: 42,
        data: 'confirm_archive:msg1',
        senderName: 'User',
      },
      {
        archiveTracker: tracker,
        autoApproval: { cancel: vi.fn() } as any,
        statusBar: { removePendingItem: vi.fn() } as any,
        gmailOps: mockGmailOps,
        findChannel: () => mockChannel as any,
      },
    );

    // 5. Verify Gmail API was called and DB updated
    expect(mockGmailOps.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
    );
    expect(tracker.getUnarchived()).toHaveLength(0);
  });

  it('GmailOpsRouter dispatches to correct channel', async () => {
    const router = new GmailOpsRouter();
    const personalChannel = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('body'),
    };
    const devChannel = {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('dev body'),
    };

    router.register('personal', personalChannel);
    router.register('dev', devChannel);

    await router.archiveThread('personal', 't1');
    await router.archiveThread('dev', 't2');

    expect(personalChannel.archiveThread).toHaveBeenCalledWith('t1');
    expect(devChannel.archiveThread).toHaveBeenCalledWith('t2');
    expect(personalChannel.archiveThread).toHaveBeenCalledTimes(1);
  });

  it('expand callback fetches and caches email body', async () => {
    const mockGmailOps = {
      archiveThread: vi.fn(),
      listRecentDrafts: vi.fn(),
      updateDraft: vi.fn(),
      getMessageBody: vi
        .fn()
        .mockResolvedValue('This is the full email body text'),
    };
    const mockChannel = {
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
    };

    await handleCallback(
      {
        id: 'q2',
        chatJid: 'telegram:456',
        messageId: 99,
        data: 'expand:emailXYZ:personal',
        senderName: 'User',
      },
      {
        archiveTracker: {
          getUnarchived: vi.fn().mockReturnValue([]),
          markArchived: vi.fn(),
          recordAction: vi.fn(),
        } as any,
        autoApproval: { cancel: vi.fn() } as any,
        statusBar: { removePendingItem: vi.fn() } as any,
        gmailOps: mockGmailOps,
        findChannel: () => mockChannel as any,
      },
    );

    expect(mockGmailOps.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'emailXYZ',
    );
    expect(mockChannel.editMessageTextAndButtons).toHaveBeenCalled();
  });
});
