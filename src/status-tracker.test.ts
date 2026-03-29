import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => '[]'),
      mkdirSync: vi.fn(),
    },
  };
});

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  StatusTracker,
  StatusState,
  StatusTrackerDeps,
} from './status-tracker.js';

const MAIN_JID = 'main@s.whatsapp.net';

function makeDeps() {
  return {
    sendReaction: vi.fn<StatusTrackerDeps['sendReaction']>(async () => {}),
    sendMessage: vi.fn<StatusTrackerDeps['sendMessage']>(async () => {}),
    isRegisteredGroup: vi.fn<StatusTrackerDeps['isRegisteredGroup']>(
      (jid) => jid === MAIN_JID || jid === 'group@g.us',
    ),
    isMainGroup: vi.fn<StatusTrackerDeps['isMainGroup']>(
      (jid) => jid === MAIN_JID,
    ),
    isContainerAlive: vi.fn<StatusTrackerDeps['isContainerAlive']>(() => true),
  };
}

describe('StatusTracker', () => {
  let tracker: StatusTracker;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
    tracker = new StatusTracker(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('forward-only transitions', () => {
    it('transitions RECEIVED -> THINKING -> WORKING -> DONE', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);
      tracker.markWorking('msg1', MAIN_JID);
      tracker.markDone('msg1', MAIN_JID);

      // Wait for all reaction sends to complete
      await tracker.flush();

      expect(deps.sendReaction).toHaveBeenCalledTimes(4);
      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual([
        '\u{1F440}',
        '\u{1F4AD}',
        '\u{1F504}',
        '\u{2705}',
      ]);
    });

    it('rejects backward transitions (WORKING -> THINKING is no-op)', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);
      tracker.markWorking('msg1', MAIN_JID);

      const result = tracker.markThinking('msg1', MAIN_JID);
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(3);
    });

    it('rejects duplicate transitions (DONE -> DONE is no-op)', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markDone('msg1', MAIN_JID);

      const result = tracker.markDone('msg1', MAIN_JID);
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
    });

    it('allows FAILED from any non-terminal state', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markFailed('msg1', MAIN_JID);
      await tracker.flush();

      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual(['\u{1F440}', '\u{274C}']);
    });

    it('rejects FAILED after DONE', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markDone('msg1', MAIN_JID);

      const result = tracker.markFailed('msg1', MAIN_JID);
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('registered group gating', () => {
    it('ignores messages from unregistered groups', async () => {
      tracker.markReceived('msg1', 'unknown@g.us', false, '', false);
      await tracker.flush();
      expect(deps.sendReaction).not.toHaveBeenCalled();
    });

    it('tracks messages from non-main registered groups', async () => {
      const result = tracker.markReceived('msg1', 'group@g.us', false, 'sender@s.whatsapp.net', false);
      expect(result).toBe(true);
      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('duplicate tracking', () => {
    it('rejects duplicate markReceived for same messageId', async () => {
      const first = tracker.markReceived('msg1', MAIN_JID, false, '', false);
      const second = tracker.markReceived('msg1', MAIN_JID, false, '', false);

      expect(first).toBe(true);
      expect(second).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown message handling', () => {
    it('returns false for transitions on untracked messages', () => {
      expect(tracker.markThinking('unknown', 'any@jid')).toBe(false);
      expect(tracker.markWorking('unknown', 'any@jid')).toBe(false);
      expect(tracker.markDone('unknown', 'any@jid')).toBe(false);
      expect(tracker.markFailed('unknown', 'any@jid')).toBe(false);
    });
  });

  describe('batch operations', () => {
    it('markAllDone transitions all tracked messages for a chatJid', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markReceived('msg2', MAIN_JID, false, '', false);
      tracker.markAllDone(MAIN_JID);
      await tracker.flush();

      const doneCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '\u{2705}',
      );
      expect(doneCalls).toHaveLength(2);
    });

    it('markAllFailed transitions all tracked messages and sends error message', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markReceived('msg2', MAIN_JID, false, '', false);
      tracker.markAllFailed(MAIN_JID, 'Task crashed');
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '\u{274C}',
      );
      expect(failCalls).toHaveLength(2);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Task crashed',
      );
    });
  });

  describe('serialized sends', () => {
    it('sends reactions in order even when transitions are rapid', async () => {
      const order: string[] = [];
      deps.sendReaction.mockImplementation(async (_jid, _key, emoji) => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        order.push(emoji);
      });

      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);
      tracker.markWorking('msg1', MAIN_JID);
      tracker.markDone('msg1', MAIN_JID);

      await tracker.flush();
      expect(order).toEqual([
        '\u{1F440}',
        '\u{1F4AD}',
        '\u{1F504}',
        '\u{2705}',
      ]);
    });
  });

  describe('recover', () => {
    it('marks orphaned non-terminal entries as failed and sends error message', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        {
          messageId: 'orphan1',
          chatJid: 'main@s.whatsapp.net',
          fromMe: false,
          state: 0,
          terminal: null,
          trackedAt: 1000,
        },
        {
          messageId: 'orphan2',
          chatJid: 'main@s.whatsapp.net',
          fromMe: false,
          state: 2,
          terminal: null,
          trackedAt: 2000,
        },
        {
          messageId: 'done1',
          chatJid: 'main@s.whatsapp.net',
          fromMe: false,
          state: 3,
          terminal: 'done',
          trackedAt: 3000,
        },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        persisted,
      );

      await tracker.recover();

      // Should send ❌ reaction for the 2 non-terminal entries only
      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCalls).toHaveLength(2);

      // Should send one error message per chatJid
      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Restarted — reprocessing your message.',
      );
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles missing persistence file gracefully', async () => {
      const fs = await import('fs');
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );

      await tracker.recover(); // should not throw
      expect(deps.sendReaction).not.toHaveBeenCalled();
    });

    it('handles composite keys correctly — same messageId from different chats', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        {
          messageId: '42',
          chatJid: 'chatA@g.us',
          fromMe: false,
          state: 1,
          terminal: null,
          trackedAt: 1000,
        },
        {
          messageId: '42',
          chatJid: 'chatB@g.us',
          fromMe: false,
          state: 2,
          terminal: null,
          trackedAt: 2000,
        },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(persisted);
      deps.isRegisteredGroup.mockReturnValue(true);

      await tracker.recover();

      // Should send ❌ for both entries (different composite keys)
      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(2);
      // Verify both chatJids got ❌
      const failedJids = failCalls.map((c) => c[0]);
      expect(failedJids).toContain('chatA@g.us');
      expect(failedJids).toContain('chatB@g.us');

      // No [system] text messages — both are non-main groups
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('skips error message when sendErrorMessage is false', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        {
          messageId: 'orphan1',
          chatJid: 'main@s.whatsapp.net',
          fromMe: false,
          state: 1,
          terminal: null,
          trackedAt: 1000,
        },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        persisted,
      );

      await tracker.recover(false);

      // Still sends ❌ reaction
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      expect(deps.sendReaction.mock.calls[0][2]).toBe('❌');
      // But no text message
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('heartbeatCheck', () => {
    it('marks messages as failed when container is dead', async () => {
      deps.isContainerAlive.mockReturnValue(false);
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);

      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Task crashed — retrying.',
      );
    });

    it('does nothing when container is alive', async () => {
      deps.isContainerAlive.mockReturnValue(true);
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);

      tracker.heartbeatCheck();
      await tracker.flush();

      // Only the 👀 and 💭 reactions, no ❌
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual(['👀', '💭']);
    });

    it('skips RECEIVED messages within grace period even if container is dead', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(false);
      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      // Only 10s elapsed — within 30s grace period
      await vi.advanceTimersByTimeAsync(10_000);
      tracker.heartbeatCheck();
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();

      // Only the 👀 reaction, no ❌
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      expect(deps.sendReaction.mock.calls[0][2]).toBe('👀');
    });

    it('fails RECEIVED messages after grace period when container is dead', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(false);
      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      // 31s elapsed — past 30s grace period
      await vi.advanceTimersByTimeAsync(31_000);
      tracker.heartbeatCheck();
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Task crashed — retrying.',
      );
    });

    it('does NOT fail RECEIVED messages after grace period when container is alive', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true);
      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      // 31s elapsed but container is alive — don't fail
      await vi.advanceTimersByTimeAsync(31_000);
      tracker.heartbeatCheck();
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();

      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      expect(deps.sendReaction.mock.calls[0][2]).toBe('👀');
    });

    it('detects stuck messages beyond timeout', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true); // container "alive" but hung

      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);

      // Advance time beyond container timeout (default 1800000ms = 30min)
      await vi.advanceTimersByTimeAsync(1_800_001);

      tracker.heartbeatCheck();
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Task timed out — retrying.',
      );
    });

    it('does not timeout messages queued long in RECEIVED before reaching THINKING', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true);

      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      // Message sits in RECEIVED for longer than CONTAINER_TIMEOUT (queued, waiting for slot)
      await vi.advanceTimersByTimeAsync(2_000_000);

      // Now container starts — trackedAt resets on THINKING transition
      tracker.markThinking('msg1', MAIN_JID);

      // Check immediately — should NOT timeout (trackedAt was just reset)
      await vi.advanceTimersByTimeAsync(1000);
      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCalls).toHaveLength(0);

      // Advance past CONTAINER_TIMEOUT from THINKING — NOW it should timeout
      await vi.advanceTimersByTimeAsync(1_800_001);

      tracker.heartbeatCheck();
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();

      const failCallsAfter = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '❌',
      );
      expect(failCallsAfter).toHaveLength(1);
    });

    it('checks multiple groups independently (failing one does not skip others)', async () => {
      vi.useFakeTimers();
      deps.isRegisteredGroup.mockReturnValue(true);
      // Container dead for chatA, alive for chatB
      deps.isContainerAlive.mockImplementation((jid) => jid === 'chatB@g.us');

      tracker.markReceived('msgA', 'chatA@g.us', false, '', false);
      tracker.markThinking('msgA', 'chatA@g.us');
      tracker.markReceived('msgB', 'chatB@g.us', false, '', false);
      tracker.markThinking('msgB', 'chatB@g.us');

      // Advance past container timeout for chatB
      await vi.advanceTimersByTimeAsync(1_800_001);

      tracker.heartbeatCheck();
      // Advance enough for all chained sends (👀 800ms + 💭 800ms + ❌ 800ms per message)
      await vi.advanceTimersByTimeAsync(5000);
      await tracker.flush();

      // Both chats should have ❌ reactions
      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(2);
      // Verify both chatJids got ❌ (not just one)
      const failedJids = failCalls.map((c) => c[0]);
      expect(failedJids).toContain('chatA@g.us');
      expect(failedJids).toContain('chatB@g.us');
    });
  });

  describe('cleanup', () => {
    it('removes terminal messages after delay', async () => {
      vi.useFakeTimers();
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markDone('msg1', MAIN_JID);

      // Message should still be tracked
      expect(tracker.isTracked('msg1', MAIN_JID)).toBe(true);

      // Advance past cleanup delay
      vi.advanceTimersByTime(6000);

      expect(tracker.isTracked('msg1', MAIN_JID)).toBe(false);
    });
  });

  describe('reaction retry', () => {
    it('retries failed sends with exponential backoff (2s, 4s)', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      deps.sendReaction.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) throw new Error('network error');
      });

      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      // First attempt fires immediately
      await vi.advanceTimersByTimeAsync(100);
      expect(callCount).toBe(1);

      // After 2s: second attempt (first retry delay = 2s)
      await vi.advanceTimersByTimeAsync(2000);
      expect(callCount).toBe(2);

      // After 1s more (3s total): still waiting for 4s delay
      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount).toBe(2);

      // After 3s more (6s total): third attempt fires (second retry delay = 4s)
      await vi.advanceTimersByTimeAsync(3000);
      expect(callCount).toBe(3);

      // Advance past the post-send transition delay
      await vi.advanceTimersByTimeAsync(1000);
      await tracker.flush();
    });

    it('gives up after max retries', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      deps.sendReaction.mockImplementation(async () => {
        callCount++;
        throw new Error('permanent failure');
      });

      tracker.markReceived('msg1', MAIN_JID, false, '', false);

      await vi.advanceTimersByTimeAsync(10_000);
      await tracker.flush();

      expect(callCount).toBe(3); // MAX_RETRIES = 3
    });
  });

  describe('batch transitions', () => {
    it('markThinking can be called on multiple messages independently', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markReceived('msg2', MAIN_JID, false, '', false);
      tracker.markReceived('msg3', MAIN_JID, false, '', false);

      // Mark all as thinking (simulates batch behavior)
      tracker.markThinking('msg1', MAIN_JID);
      tracker.markThinking('msg2', MAIN_JID);
      tracker.markThinking('msg3', MAIN_JID);

      await tracker.flush();

      const thinkingCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '💭',
      );
      expect(thinkingCalls).toHaveLength(3);
    });

    it('markWorking can be called on multiple messages independently', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markReceived('msg2', MAIN_JID, false, '', false);
      tracker.markThinking('msg1', MAIN_JID);
      tracker.markThinking('msg2', MAIN_JID);

      tracker.markWorking('msg1', MAIN_JID);
      tracker.markWorking('msg2', MAIN_JID);

      await tracker.flush();

      const workingCalls = deps.sendReaction.mock.calls.filter(
        (c) => c[2] === '🔄',
      );
      expect(workingCalls).toHaveLength(2);
    });
  });

  describe('per-JID tracking cap', () => {
    it('rejects markReceived after 20 non-terminal messages for same JID', async () => {
      for (let i = 0; i < 20; i++) {
        expect(tracker.markReceived(`msg${i}`, MAIN_JID, false, '', false)).toBe(true);
      }
      // 21st should be rejected
      expect(tracker.markReceived('msg20', MAIN_JID, false, '', false)).toBe(false);
      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(20);
    });

    it('does not count terminal entries toward cap', async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 20; i++) {
        tracker.markReceived(`msg${i}`, MAIN_JID, false, '', false);
      }
      // Mark first 5 as done (terminal)
      for (let i = 0; i < 5; i++) {
        tracker.markDone(`msg${i}`, MAIN_JID);
      }
      // Should now accept new messages (only 15 non-terminal)
      expect(tracker.markReceived('msg20', MAIN_JID, false, '', false)).toBe(true);
    });

    it('cap is per-JID — different JIDs have independent caps', async () => {
      deps.isRegisteredGroup.mockReturnValue(true);
      for (let i = 0; i < 20; i++) {
        tracker.markReceived(`msg${i}`, 'chatA@g.us', false, '', false);
      }
      // chatB should still accept
      expect(tracker.markReceived('msg0', 'chatB@g.us', false, '', false)).toBe(true);
    });
  });

  describe('system error message suppression', () => {
    it('suppresses [system] error message for non-main group failures', async () => {
      tracker.markReceived('msg1', 'group@g.us', false, 'sender@s.whatsapp.net', false);
      tracker.markAllFailed('group@g.us', 'Task crashed');
      await tracker.flush();

      // ❌ emoji should be sent
      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(1);
      // But no text message
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses [system] recovery message for non-main groups', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        {
          messageId: 'orphan1',
          chatJid: 'group@g.us',
          fromMe: false,
          state: 1,
          terminal: null,
          trackedAt: 1000,
        },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(persisted);

      await tracker.recover();

      // ❌ emoji should be sent
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      // But no text message to non-main group
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends [system] error message for main group failures', async () => {
      tracker.markReceived('msg1', MAIN_JID, false, '', false);
      tracker.markAllFailed(MAIN_JID, 'Task crashed');
      await tracker.flush();

      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Task crashed',
      );
    });

    it('sends [system] recovery message for main group', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        {
          messageId: 'orphan1',
          chatJid: MAIN_JID,
          fromMe: false,
          state: 1,
          terminal: null,
          trackedAt: 1000,
        },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(persisted);

      await tracker.recover();

      expect(deps.sendMessage).toHaveBeenCalledWith(
        MAIN_JID,
        '[system] Restarted — reprocessing your message.',
      );
    });
  });

  describe('piping path emoji sequence', () => {
    it('markReceived then markThinking produces eyes then thinking emoji', async () => {
      deps.isRegisteredGroup.mockReturnValue(true);

      tracker.markReceived('msg1', 'group@g.us', false, 'sender@s.whatsapp.net', false);
      tracker.markThinking('msg1', 'group@g.us');

      await tracker.flush();

      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual(['\u{1F440}', '\u{1F4AD}']);
      // Verify reactions sent to the correct chat
      expect(deps.sendReaction.mock.calls[0][0]).toBe('group@g.us');
    });
  });

  describe('composite key isolation', () => {
    it('tracks same messageId in different chatJids independently', async () => {
      // Both chats are "registered"
      deps.isRegisteredGroup.mockReturnValue(true);

      tracker.markReceived('42', 'chatA@g.us', false, '', false);
      tracker.markReceived('42', 'chatB@g.us', false, '', false);

      await tracker.flush();
      // Should get 2 👀 reactions (one per chat), not 1
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
    });
  });
});
