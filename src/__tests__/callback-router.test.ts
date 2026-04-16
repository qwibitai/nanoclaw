import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../callback-router.js';
import type { CallbackRouterDeps } from '../callback-router.js';

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
    expect(deps.gmailOps!.archiveThread).toHaveBeenCalledWith('personal', 'thread1');
    expect(deps.archiveTracker.markArchived).toHaveBeenCalledWith('email1', 'replied');
  });

  it('cancel_archive reverts buttons (no archive call)', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('cancel_archive:email1'), deps);
    expect(deps.gmailOps!.archiveThread).not.toHaveBeenCalled();
  });

  it('expand fetches body and edits message with preview', async () => {
    const deps = makeDeps();
    await handleCallback(makeQuery('expand:msg1:personal'), deps);
    expect(deps.gmailOps!.getMessageBody).toHaveBeenCalledWith('personal', 'msg1');
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
    expect(channel.editMessageButtons).toHaveBeenCalledWith('telegram:123', 100, []);
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
});
