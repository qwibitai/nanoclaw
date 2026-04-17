import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCallback } from '../callback-router.js';
import type { CallbackRouterDeps } from '../callback-router.js';

vi.mock('../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config.js')>();
  return { ...original, MINI_APP_URL: 'https://app.example.com' };
});

/**
 * Exhaustive matrix covering every callback action the Telegram bot emits.
 * Runs headlessly against mocked channel + gmailOps so we don't need a real
 * bot token. Covers: happy path for each action, Gmail-outage retry flow,
 * Yes/No routing to agent, and graceful handling of unknown actions.
 */

type Channel = {
  editMessageButtons: ReturnType<typeof vi.fn>;
  editMessageTextAndButtons: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageWithActions: ReturnType<typeof vi.fn>;
};

function makeChannel(): Channel {
  return {
    editMessageButtons: vi.fn().mockResolvedValue(undefined),
    editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithActions: vi.fn().mockResolvedValue(42),
  };
}

function makeDeps(overrides: Partial<CallbackRouterDeps> = {}): {
  deps: CallbackRouterDeps;
  channel: Channel;
  injectUserReply: ReturnType<typeof vi.fn>;
} {
  const channel = makeChannel();
  const injectUserReply = vi.fn().mockReturnValue(true);
  const deps: CallbackRouterDeps = {
    archiveTracker: {
      markArchived: vi.fn(),
      getUnarchived: vi.fn().mockReturnValue([
        {
          email_id: 'e1',
          thread_id: 't1',
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
    findChannel: vi.fn().mockReturnValue(channel),
    gmailOps: {
      archiveThread: vi.fn().mockResolvedValue(undefined),
      getMessageBody: vi.fn().mockResolvedValue('Full body.'),
      listRecentDrafts: vi.fn().mockResolvedValue([]),
    } as any,
    injectUserReply,
    ...overrides,
  };
  return { deps, channel, injectUserReply };
}

function query(data: string, messageId = 100) {
  return {
    id: 'q',
    chatJid: 'tg:123',
    messageId,
    data,
    senderName: 'User',
  };
}

describe('Telegram callback matrix — happy paths', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it('archive → shows confirm/cancel', async () => {
    await handleCallback(query('archive:e1'), ctx.deps);
    expect(ctx.channel.editMessageButtons).toHaveBeenCalledWith(
      'tg:123',
      100,
      expect.arrayContaining([
        expect.objectContaining({ callbackData: 'confirm_archive:e1' }),
      ]),
    );
  });

  it('confirm_archive → archives thread and marks archived', async () => {
    await handleCallback(query('confirm_archive:e1'), ctx.deps);
    expect(ctx.deps.gmailOps!.archiveThread).toHaveBeenCalledWith(
      'personal',
      't1',
    );
    expect(ctx.deps.archiveTracker.markArchived).toHaveBeenCalledWith(
      'e1',
      'replied',
    );
  });

  it('answer:yes → injects reply into agent', async () => {
    await handleCallback(query('answer:q1:yes'), ctx.deps);
    expect(ctx.injectUserReply).toHaveBeenCalledWith(
      'tg:123',
      expect.stringMatching(/yes.*proceed/i),
    );
  });

  it('answer:no → injects rejection into agent', async () => {
    await handleCallback(query('answer:q1:no'), ctx.deps);
    expect(ctx.injectUserReply).toHaveBeenCalledWith(
      'tg:123',
      expect.stringMatching(/no.*not proceed/i),
    );
  });

  it('dismiss → removes status bar item', async () => {
    await handleCallback(query('dismiss:item1'), ctx.deps);
    expect(ctx.deps.statusBar.removePendingItem).toHaveBeenCalledWith('item1');
  });

  it('stop → cancels auto-approval', async () => {
    await handleCallback(query('stop:timer1'), ctx.deps);
    expect(ctx.deps.autoApproval.cancel).toHaveBeenCalledWith('timer1');
  });

  it('unknown action → logs warning (no throw)', async () => {
    await expect(
      handleCallback(query('totally_unknown:xyz'), ctx.deps),
    ).resolves.not.toThrow();
  });
});

describe('Telegram callback matrix — Gmail-outage retry flow', () => {
  it('expand failure (Gmail outage) renders Retry + Dismiss buttons', async () => {
    const { deps, channel } = makeDeps({
      gmailOps: {
        archiveThread: vi.fn(),
        getMessageBody: vi
          .fn()
          .mockRejectedValue(
            new Error('No Gmail channel registered for account: x'),
          ),
        listRecentDrafts: vi.fn(),
      } as any,
    });
    await handleCallback(query('expand:e1:personal'), deps);
    expect(channel.editMessageTextAndButtons).toHaveBeenCalledWith(
      'tg:123',
      100,
      expect.stringContaining('failed'),
      expect.arrayContaining([
        expect.objectContaining({
          callbackData: expect.stringMatching(/^retry:expand:e1/),
        }),
        expect.objectContaining({
          callbackData: expect.stringMatching(/^dismiss_failure:/),
        }),
      ]),
    );
  });

  it('retry:expand re-dispatches the original expand call', async () => {
    const getMessageBody = vi.fn().mockResolvedValue('Body after retry.');
    const { deps, channel } = makeDeps({
      gmailOps: {
        archiveThread: vi.fn(),
        getMessageBody,
        listRecentDrafts: vi.fn(),
      } as any,
    });
    await handleCallback(query('retry:expand:e1:personal'), deps);
    expect(getMessageBody).toHaveBeenCalledWith('personal', 'e1');
    // After successful retry, message should be edited with the full body.
    expect(channel.editMessageTextAndButtons).toHaveBeenCalledWith(
      'tg:123',
      100,
      expect.stringContaining('Body after retry'),
      expect.anything(),
    );
  });

  it('dismiss_failure clears the keyboard', async () => {
    const { deps, channel } = makeDeps();
    await handleCallback(query('dismiss_failure:e1'), deps);
    expect(channel.editMessageButtons).toHaveBeenCalledWith('tg:123', 100, []);
  });

  it('non-retryable failure (rsvp) does NOT emit retry buttons', async () => {
    const { deps, channel } = makeDeps({
      calendarOps: {
        rsvp: vi.fn().mockRejectedValue(new Error('Network')),
      },
    });
    await handleCallback(query('rsvp:event1:accepted'), deps);
    // RSVP has its own failure handler — should not fall into the generic
    // catch that would emit retry buttons. Assert last call rendered plain
    // failure text with no retry-style buttons.
    const lastCall =
      channel.editMessageTextAndButtons.mock.calls[
        channel.editMessageTextAndButtons.mock.calls.length - 1
      ];
    expect(lastCall[3]).toEqual([]);
  });
});
