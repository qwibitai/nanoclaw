import { describe, it, expect, vi } from 'vitest';
import { handleCallback, resolveFullEmailUrl } from '../callback-router.js';
import type { CallbackRouterDeps } from '../callback-router.js';

vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>();
  return { ...original, MINI_APP_URL: 'https://app.example.com' };
});

function makeDeps(): CallbackRouterDeps {
  return {
    archiveTracker: {
      markArchived: vi.fn(),
      getUnarchived: vi.fn().mockReturnValue([
        {
          email_id: 'email1',
          thread_id: 'thread1',
          account: 'personal',
          action_taken: 'replied',
          acted_at: new Date().toISOString(),
          archived_at: null,
        },
      ]),
      recordAction: vi.fn(),
      getByEmailId: vi.fn().mockReturnValue(null),
    } as any,
    autoApproval: { cancel: vi.fn() } as any,
    statusBar: { removePendingItem: vi.fn() } as any,
    findChannel: vi.fn().mockReturnValue({
      editMessageButtons: vi.fn().mockResolvedValue(undefined),
      editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
    }),
    gmailOps: {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
      updateDraft: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Full email body here'),
    } as any,
    draftWatcher: {
      revert: vi.fn().mockResolvedValue(true),
    } as any,
  };
}

function makeQuery(data: string, messageId = 100) {
  return {
    id: 'q1',
    chatJid: 'telegram:123',
    messageId,
    data,
    senderName: 'User',
  };
}

describe('handleCallback', () => {
  it('archive shows confirm/cancel buttons', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('archive:email1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({ callbackData: 'confirm_archive:email1' }),
        expect.objectContaining({ callbackData: 'cancel_archive:email1' }),
      ]),
    );
  });

  it('confirm_archive calls gmailOps.archiveThread and marks archived', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('confirm_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
    );
    expect(deps.archiveTracker.markArchived).toHaveBeenCalledWith(
      'email1',
      'replied',
    );
  });

  it('cancel_archive reverts buttons (no archive call)', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('cancel_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).not.toHaveBeenCalled();
  });

  it('expand fetches body and edits message with preview', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('expand:msg1:personal'), deps);
    expect(deps.gmailOps!.getMessageBody).toHaveBeenCalledWith(
      'personal',
      'msg1',
    );
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('collapse edits message back to summary', async () => {
    const deps = makeDeps();
    // First cache a body so collapse can use it
    const { cacheEmailBody } = await import('../email-preview.js');
    cacheEmailBody('msg1', 'A'.repeat(500));
    await handleCallback(makeQuery('collapse:msg1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('expand uses getMessageMeta when available to populate cache', async () => {
    const deps = makeDeps();
    const metaMock = vi.fn().mockResolvedValue({
      subject: 'Test Subject',
      from: 'sender@example.com',
      to: 'me@example.com',
      date: '2026-04-16',
      body: 'Meta email body',
    });
    (deps.gmailOps as any).getMessageMeta = metaMock;
    // Override getMessageBody to return null to confirm it is not used
    (deps.gmailOps!.getMessageBody as any).mockResolvedValue(null);
    await handleCallback(makeQuery('expand:msg-meta-test:personal'), deps);
    expect(metaMock).toHaveBeenCalledWith('personal', 'msg-meta-test');
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('expand passes account through to Collapse callback data', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('expand:msg1:personal'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    const [, , , buttons] = channel.editMessageTextAndButtons.mock.calls[0];
    const collapseBtn = buttons.find((b: any) => b.label.includes('Collapse'));
    expect(collapseBtn.callbackData).toBe('collapse:msg1:personal');
  });

  it('collapse passes account through to Expand and Full Email buttons', async () => {
    const deps = makeDeps();
    const { cacheEmailBody } = await import('../email-preview.js');
    cacheEmailBody('msg1', 'B'.repeat(500));
    await handleCallback(makeQuery('collapse:msg1:personal'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    const [, , , buttons] = channel.editMessageTextAndButtons.mock.calls[0];
    const expandBtn = buttons.find((b: any) => b.label.includes('Expand'));
    expect(expandBtn.callbackData).toBe('expand:msg1:personal');
    const fullEmailBtn = buttons.find((b: any) =>
      b.label.includes('Full Email'),
    );
    expect(fullEmailBtn.webAppUrl).toContain('?account=personal');
  });

  it('collapse without account still works (graceful degradation)', async () => {
    const deps = makeDeps();
    const { cacheEmailBody } = await import('../email-preview.js');
    cacheEmailBody('msg1', 'C'.repeat(500));
    await handleCallback(makeQuery('collapse:msg1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
    const [, , , buttons] = channel.editMessageTextAndButtons.mock.calls[0];
    const expandBtn = buttons.find((b: any) => b.label.includes('Expand'));
    expect(expandBtn.callbackData).toBe('expand:msg1');
  });

  it('revert calls draftWatcher.revert and edits message', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('revert:draft1'), deps);
    expect(deps.draftWatcher!.revert).toHaveBeenCalledWith('draft1');
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalled();
  });

  it('keep removes buttons', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('keep:draft1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      [],
    );
  });

  it('stop cancels auto-approval', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('stop:task1'), deps);
    expect(deps.autoApproval.cancel).toHaveBeenCalledWith('task1');
  });

  it('dismiss removes pending item', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('dismiss:item1'), deps);
    expect(deps.statusBar.removePendingItem).toHaveBeenCalledWith('item1');
  });

  it('confirm_archive retries on error and shows retry button', async () => {
    const deps = makeDeps();
    (deps.archiveTracker.getUnarchived as any).mockReturnValue([
      {
        email_id: 'email1',
        thread_id: 'thread1',
        account: 'topcoder1@gmail.com',
        action_taken: 'replied',
        acted_at: new Date().toISOString(),
        archived_at: null,
      },
    ]);
    (deps.gmailOps!.archiveThread as any).mockRejectedValue(
      new Error('No Gmail channel registered for account: topcoder1@gmail.com'),
    );
    await handleCallback(makeQuery('confirm_archive:email1'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.stringContaining("Couldn't archive"),
      expect.arrayContaining([
        expect.objectContaining({
          callbackData: 'retry_archive:email1',
        }),
      ]),
    );
  });

  it('retry_archive re-attempts archiveThread', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('retry_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
    );
    expect(deps.archiveTracker.markArchived).toHaveBeenCalledWith(
      'email1',
      'replied',
    );
  });

  it('forward shows confirmation buttons', async () => {
    const deps = makeDeps();
    await handleCallback(
      makeQuery('forward:thread1:alice@example.com:personal'),
      deps,
    );
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({
          callbackData: 'confirm_forward:thread1:alice@example.com:personal',
        }),
        expect.objectContaining({
          callbackData: expect.stringContaining('cancel_forward'),
        }),
      ]),
    );
  });

  it('confirm_forward calls gmailOps.forwardThread', async () => {
    const deps = makeDeps();
    (deps.gmailOps as any).forwardThread = vi.fn().mockResolvedValue(undefined);
    await handleCallback(
      makeQuery('confirm_forward:thread1:alice@example.com:personal'),
      deps,
    );
    expect((deps.gmailOps as any).forwardThread).toHaveBeenCalledWith(
      'personal',
      'thread1',
      'alice@example.com',
    );
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.stringContaining('Forwarded'),
      [],
    );
  });

  it('cancel_forward restores forward button', async () => {
    const deps = makeDeps();
    await handleCallback(
      makeQuery('cancel_forward:thread1:alice@example.com:personal'),
      deps,
    );
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({
          callbackData: 'forward:thread1:alice@example.com:personal',
        }),
      ]),
    );
  });

  it('open_url shows confirmation with URL', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('open_url:act_123'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({
          callbackData: 'confirm_open_url:act_123',
        }),
        expect.objectContaining({
          callbackData: 'cancel_open_url:act_123',
        }),
      ]),
    );
  });

  it('rsvp:accepted calls calendarOps.rsvp', async () => {
    const deps = makeDeps();
    (deps as any).calendarOps = {
      rsvp: vi.fn().mockResolvedValue(undefined),
    };
    await handleCallback(makeQuery('rsvp:evt1:accepted'), deps);
    expect((deps as any).calendarOps.rsvp).toHaveBeenCalledWith(
      expect.any(String),
      'evt1',
      'accepted',
    );
  });

  it('rsvp:declined shows declined message', async () => {
    const deps = makeDeps();
    (deps as any).calendarOps = {
      rsvp: vi.fn().mockResolvedValue(undefined),
    };
    await handleCallback(makeQuery('rsvp:evt1:declined'), deps);
    const channel = (deps.findChannel as any).mock.results[0]?.value;
    expect(channel.editMessageTextAndButtons).toHaveBeenCalledWith(
      'telegram:123',
      100,
      expect.stringContaining('Declined'),
      [],
    );
  });
});

describe('resolveFullEmailUrl', () => {
  it('uses /reply/:draftId when a draft exists', () => {
    const url = resolveFullEmailUrl({
      emailId: 'email-X',
      account: 'personal',
      draftIdForThread: 'draft-for-thread-X',
    });
    expect(url).toMatch(/\/reply\/draft-for-thread-X\?account=personal$/);
  });

  it('uses /email/:emailId when no draft exists', () => {
    const url = resolveFullEmailUrl({
      emailId: 'email-Y',
      account: 'personal',
      draftIdForThread: null,
    });
    expect(url).toMatch(/\/email\/email-Y\?account=personal$/);
  });

  it('URL-encodes emailId and account', () => {
    const url = resolveFullEmailUrl({
      emailId: 'email with space',
      account: 'has@at.com',
      draftIdForThread: null,
    });
    expect(url).toContain('email%20with%20space');
    expect(url).toContain('has%40at.com');
  });
});
