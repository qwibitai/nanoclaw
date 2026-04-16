import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../callback-router.js';

describe('handleCallback', () => {
  const mockDeps = {
    archiveTracker: { markArchived: vi.fn(), recordAction: vi.fn(), getUnarchived: vi.fn() },
    autoApproval: { cancel: vi.fn(), start: vi.fn(), getRemainingMs: vi.fn(), destroy: vi.fn() },
    statusBar: { removePendingItem: vi.fn(), addPendingItem: vi.fn(), incrementAutoHandled: vi.fn(), incrementDraftsEnriched: vi.fn(), destroy: vi.fn() },
    findChannel: vi.fn(),
  };

  it('routes stop to autoApproval.cancel', () => {
    handleCallback(
      { id: '1', chatJid: 'tg:123', messageId: 1, data: 'stop:task-1', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.autoApproval.cancel).toHaveBeenCalledWith('task-1');
  });

  it('routes confirm_archive to archiveTracker', () => {
    handleCallback(
      { id: '2', chatJid: 'tg:123', messageId: 2, data: 'confirm_archive:msg_1', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.archiveTracker.markArchived).toHaveBeenCalledWith('msg_1', 'archived');
  });

  it('routes answer:defer to keep pending', () => {
    handleCallback(
      { id: '3', chatJid: 'tg:123', messageId: 3, data: 'answer:q_1:defer', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.statusBar.removePendingItem).not.toHaveBeenCalled();
  });

  it('routes answer:yes to remove pending', () => {
    handleCallback(
      { id: '4', chatJid: 'tg:123', messageId: 4, data: 'answer:q_1:yes', senderName: 'Jon' },
      mockDeps as any,
    );
    expect(mockDeps.statusBar.removePendingItem).toHaveBeenCalledWith('q_1');
  });
});
