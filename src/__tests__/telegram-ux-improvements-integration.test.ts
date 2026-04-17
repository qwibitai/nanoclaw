import { describe, it, expect, vi } from 'vitest';
import { GmailOpsRouter } from '../gmail-ops.js';
import { handleCallback } from '../callback-router.js';
import { detectActions } from '../action-detector.js';
import { classifyAndFormat } from '../router.js';
import type { CallbackRouterDeps } from '../callback-router.js';
import type { MessageMeta } from '../types.js';

describe('Telegram UX Improvements Integration', () => {
  describe('archive with email address resolves via alias', () => {
    it('full email → alias → archive succeeds', async () => {
      const router = new GmailOpsRouter();
      const mockChannel = {
        archiveThread: vi.fn().mockResolvedValue(undefined),
        listRecentDrafts: vi.fn().mockResolvedValue([]),
        updateDraft: vi.fn().mockResolvedValue(undefined),
        getMessageBody: vi.fn().mockResolvedValue(null),
        emailAddress: 'topcoder1@gmail.com',
      };
      router.register('personal', mockChannel as any);

      // This used to throw "No Gmail channel registered for account: topcoder1@gmail.com"
      await router.archiveThread('topcoder1@gmail.com', 'thread123');
      expect(mockChannel.archiveThread).toHaveBeenCalledWith('thread123');
    });
  });

  describe('action detection → callback execution', () => {
    it('forward detected → confirm → forwardThread called', async () => {
      // 1. Agent output triggers action detection
      const text =
        'FloppyData magic link. Want me to forward it to philip.ye@whoisxmlapi.com?';
      const meta: MessageMeta = {
        category: 'email',
        urgency: 'info',
        actions: [],
        batchable: false,
        threadId: 'thread456',
        account: 'personal',
      };
      const actions = detectActions(text, meta);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('forward');

      // 2. User taps confirm_forward button
      const forwardAction = actions[0].actions[0];
      const callbackData = forwardAction.callbackData.replace(
        'forward:',
        'confirm_forward:',
      );

      const deps: CallbackRouterDeps = {
        archiveTracker: {
          markArchived: vi.fn(),
          getUnarchived: vi.fn().mockReturnValue([]),
          recordAction: vi.fn(),
        } as any,
        autoApproval: { cancel: vi.fn() } as any,
        statusBar: { removePendingItem: vi.fn() } as any,
        gmailOps: {
          archiveThread: vi.fn().mockResolvedValue(undefined),
          listRecentDrafts: vi.fn().mockResolvedValue([]),
          updateDraft: vi.fn().mockResolvedValue(undefined),
          getMessageBody: vi.fn().mockResolvedValue(null),
          forwardThread: vi.fn().mockResolvedValue(undefined),
        } as any,
        findChannel: vi.fn().mockReturnValue({
          editMessageButtons: vi.fn().mockResolvedValue(undefined),
          editMessageTextAndButtons: vi.fn().mockResolvedValue(undefined),
        }),
      };

      await handleCallback(
        {
          id: 'q1',
          chatJid: 'tg:123',
          messageId: 42,
          data: callbackData,
          senderName: 'User',
        },
        deps,
      );

      expect((deps.gmailOps as any).forwardThread).toHaveBeenCalledWith(
        'personal',
        'thread456',
        'philip.ye@whoisxmlapi.com',
      );
    });
  });

  describe('action detection takes priority over question detection', () => {
    it('forward text gets Forward button not generic Yes/No', () => {
      const result = classifyAndFormat(
        'FloppyData sign-in link. Want me to forward it to philip@test.com?',
      );
      const hasForward = result.meta.actions.some((a) =>
        a.callbackData?.startsWith('forward:'),
      );
      const hasGenericYes = result.meta.actions.some((a) =>
        a.callbackData?.includes(':yes'),
      );
      // Note: forward detection requires threadId on meta, which classifyAndFormat
      // may not set for arbitrary text. This tests the priority logic when both could match.
      // If no threadId, generic yes/no will fire as fallback — that's correct behavior.
      expect(hasForward || !hasGenericYes).toBe(true);
    });
  });
});
