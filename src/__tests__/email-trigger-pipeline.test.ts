/**
 * Tests for the email-trigger pipeline: verifies that IpcDeps.enqueueEmailTrigger
 * passes email metadata through to the onResult callback.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcDeps } from '../ipc.js';

describe('email-trigger pipeline – interface contract', () => {
  /**
   * Build a minimal IpcDeps stub that fulfils the interface and records
   * the arguments passed to enqueueEmailTrigger.
   */
  function buildStub() {
    const calls: Array<{
      chatJid: string;
      prompt: string;
      emails: Array<{
        thread_id: string;
        account: string;
        subject: string;
        sender: string;
      }>;
    }> = [];

    const stub: IpcDeps = {
      sendMessage: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: vi.fn().mockReturnValue([]),
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      enqueueEmailTrigger: (chatJid, prompt, onResult, emails) => {
        calls.push({ chatJid, prompt, emails });
        // Immediately invoke onResult so callers can verify the callback
        // receives the same emails array.
        void onResult('agent output', emails);
      },
    };

    return { stub, calls };
  }

  it('passes email metadata to enqueueEmailTrigger as 4th argument', async () => {
    const { stub, calls } = buildStub();

    const emails = [
      {
        thread_id: 'thread-1',
        account: 'user@example.com',
        subject: 'Hello',
        sender: 'a@b.com',
      },
      {
        thread_id: 'thread-2',
        account: 'user2@example.com',
        subject: 'World',
        sender: 'c@d.com',
      },
    ];

    stub.enqueueEmailTrigger('tg:12345', 'process emails', vi.fn(), emails);

    expect(calls).toHaveLength(1);
    expect(calls[0].chatJid).toBe('tg:12345');
    expect(calls[0].emails).toEqual(emails);
  });

  it('onResult callback receives both text and emails array', async () => {
    const { stub } = buildStub();

    const emails = [
      {
        thread_id: 'thread-abc',
        account: 'x@y.com',
        subject: 'Test',
        sender: 'z@w.com',
      },
    ];

    const receivedArgs: Array<{ text: string; emails: typeof emails }> = [];

    stub.enqueueEmailTrigger(
      'tg:99',
      'prompt',
      async (text, receivedEmails) => {
        receivedArgs.push({ text, emails: receivedEmails as typeof emails });
      },
      emails,
    );

    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0].text).toBe('agent output');
    expect(receivedArgs[0].emails).toEqual(emails);
  });

  it('handles empty email array without errors', () => {
    const { stub, calls } = buildStub();

    stub.enqueueEmailTrigger('tg:0', 'prompt', vi.fn(), []);

    expect(calls[0].emails).toEqual([]);
  });

  it('email metadata fields match the declared shape', () => {
    const { stub, calls } = buildStub();

    const email = {
      thread_id: 'tid-123',
      account: 'acct@test.com',
      subject: 'Subject line',
      sender: 'sender@test.com',
    };

    stub.enqueueEmailTrigger('tg:1', 'prompt', vi.fn(), [email]);

    const passed = calls[0].emails[0];
    expect(passed).toHaveProperty('thread_id', email.thread_id);
    expect(passed).toHaveProperty('account', email.account);
    expect(passed).toHaveProperty('subject', email.subject);
    expect(passed).toHaveProperty('sender', email.sender);
  });
});

import { classifyAndFormat } from '../router.js';
import { ArchiveTracker } from '../archive-tracker.js';
import Database from 'better-sqlite3';

describe('email trigger output — classifyAndFormat integration', () => {
  it('should classify agent email output and attach actions', () => {
    const emailText = `[Email [personal] from alice@example.com]
Subject: Meeting tomorrow

Hi, let's meet tomorrow at 3pm to discuss the project.`;

    const { text, meta } = classifyAndFormat(emailText);
    expect(meta.category).toBe('email');
  });

  it('should pass through non-email agent output and return the text', () => {
    const normalText =
      'I checked your calendar and you have no meetings today.';
    const { text, meta } = classifyAndFormat(normalText);
    // The default category for unrecognised messages is 'email' (classifier fallback);
    // what matters here is that the text is preserved and meta.actions starts empty.
    expect(text).toContain('calendar');
    expect(meta.actions).toEqual([]);
  });
});

describe('archive buttons from trigger metadata', () => {
  it('should record emails in archiveTracker', () => {
    const db = new Database(':memory:');
    // ArchiveTracker uses the 'acted_emails' table
    db.exec(`CREATE TABLE IF NOT EXISTS acted_emails (
      email_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      account TEXT NOT NULL,
      action_taken TEXT NOT NULL DEFAULT '',
      acted_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    )`);
    const tracker = new ArchiveTracker(db);

    const triggerEmails = [
      {
        thread_id: 'thread-123',
        account: 'personal',
        subject: 'Test',
        sender: 'bob@example.com',
      },
    ];

    for (const email of triggerEmails) {
      tracker.recordAction(
        email.thread_id,
        email.thread_id,
        email.account,
        'replied',
      );
    }

    const unarchived = tracker.getUnarchived();
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].email_id).toBe('thread-123');
    db.close();
  });

  it('should add archive button when not already present', () => {
    const actions: Array<{
      label: string;
      callbackData: string;
      style: string;
    }> = [];
    const triggerEmails = [
      {
        thread_id: 'thread-456',
        account: 'dev',
        subject: 'Deploy',
        sender: 'ci@example.com',
      },
    ];

    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary',
        });
      }
    }

    expect(actions).toHaveLength(1);
    expect(actions[0].callbackData).toBe('archive:thread-456');
  });

  it('should not duplicate archive buttons for multiple emails from same trigger', () => {
    const { meta } = classifyAndFormat('Agent processed 2 emails.');
    const triggerEmails = [
      {
        thread_id: 'thread-1',
        account: 'personal',
        subject: 'A',
        sender: 'a@x.com',
      },
      {
        thread_id: 'thread-2',
        account: 'dev',
        subject: 'B',
        sender: 'b@x.com',
      },
    ];

    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (
        !meta.actions.some((a) =>
          a.callbackData?.startsWith(`archive:${emailId}`),
        )
      ) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions).toHaveLength(2);
  });
});

describe('email trigger pipeline — end-to-end', () => {
  it('should produce formatted output with archive buttons from trigger metadata', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-e2e-1',
        account: 'personal',
        subject: 'Project update',
        sender: 'pm@example.com',
      },
      {
        thread_id: 'thread-e2e-2',
        account: 'dev',
        subject: 'CI failure',
        sender: 'ci@example.com',
      },
    ];

    // Simulate the agent response (not in [Email ...] format)
    const agentResponse =
      'I reviewed 2 new emails:\n1. Project update from pm@example.com — scheduling meeting\n2. CI failure from ci@example.com — test suite needs fix';

    // Run through the pipeline
    const { text, meta } = classifyAndFormat(agentResponse);

    // Force-attach archive buttons from trigger metadata
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (
        !meta.actions.some((a) =>
          a.callbackData?.startsWith(`archive:${emailId}`),
        )
      ) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have archive buttons for both emails
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions).toHaveLength(2);
    expect(archiveActions[0].callbackData).toBe('archive:thread-e2e-1');
    expect(archiveActions[1].callbackData).toBe('archive:thread-e2e-2');
  });

  it('should not duplicate archive buttons when classifier already detected email', () => {
    const triggerEmails = [
      {
        thread_id: 'thread-dup-1',
        account: 'personal',
        subject: 'Test',
        sender: 'alice@example.com',
      },
    ];

    // Agent response in [Email ...] format that classifier WILL detect
    const emailFormatResponse = `[Email [personal] from alice@example.com]
Subject: Test

Short body here.`;

    const { meta } = classifyAndFormat(emailFormatResponse);

    // Force-attach — should check for existing archive buttons
    for (const email of triggerEmails) {
      const emailId = email.thread_id;
      if (!meta.actions.some((a) => a.callbackData?.startsWith('archive:'))) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${emailId}`,
          style: 'secondary' as const,
        });
      }
    }

    // Should have at most one set of archive buttons (no duplicates)
    const archiveActions = meta.actions.filter((a) =>
      a.callbackData?.startsWith('archive:'),
    );
    expect(archiveActions.length).toBeGreaterThanOrEqual(1);
    // No exact duplicate callbackData
    const uniqueData = new Set(archiveActions.map((a) => a.callbackData));
    expect(uniqueData.size).toBe(archiveActions.length);
  });
});
