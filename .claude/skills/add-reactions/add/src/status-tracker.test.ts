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

import { StatusTracker, StatusState, StatusTrackerDeps } from './status-tracker.js';

function makeDeps() {
  return {
    sendReaction: vi.fn<StatusTrackerDeps['sendReaction']>(async () => {}),
    sendMessage: vi.fn<StatusTrackerDeps['sendMessage']>(async () => {}),
    isMainGroup: vi.fn<StatusTrackerDeps['isMainGroup']>((jid) => jid === 'main@s.whatsapp.net'),
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
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');
      tracker.markWorking('msg1');
      tracker.markDone('msg1');

      // Wait for all reaction sends to complete
      await tracker.flush();

      expect(deps.sendReaction).toHaveBeenCalledTimes(4);
      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual(['\u{1F440}', '\u{1F4AD}', '\u{1F504}', '\u{2705}']);
    });

    it('rejects backward transitions (WORKING -> THINKING is no-op)', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');
      tracker.markWorking('msg1');

      const result = tracker.markThinking('msg1');
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(3);
    });

    it('rejects duplicate transitions (DONE -> DONE is no-op)', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markDone('msg1');

      const result = tracker.markDone('msg1');
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
    });

    it('allows FAILED from any non-terminal state', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markFailed('msg1');
      await tracker.flush();

      const emojis = deps.sendReaction.mock.calls.map((c) => c[2]);
      expect(emojis).toEqual(['\u{1F440}', '\u{274C}']);
    });

    it('rejects FAILED after DONE', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markDone('msg1');

      const result = tracker.markFailed('msg1');
      expect(result).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('main group gating', () => {
    it('ignores messages from non-main groups', async () => {
      tracker.markReceived('msg1', 'group@g.us', false);
      await tracker.flush();
      expect(deps.sendReaction).not.toHaveBeenCalled();
    });
  });

  describe('duplicate tracking', () => {
    it('rejects duplicate markReceived for same messageId', async () => {
      const first = tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      const second = tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      expect(first).toBe(true);
      expect(second).toBe(false);

      await tracker.flush();
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('unknown message handling', () => {
    it('returns false for transitions on untracked messages', () => {
      expect(tracker.markThinking('unknown')).toBe(false);
      expect(tracker.markWorking('unknown')).toBe(false);
      expect(tracker.markDone('unknown')).toBe(false);
      expect(tracker.markFailed('unknown')).toBe(false);
    });
  });

  describe('batch operations', () => {
    it('markAllDone transitions all tracked messages for a chatJid', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markReceived('msg2', 'main@s.whatsapp.net', false);
      tracker.markAllDone('main@s.whatsapp.net');
      await tracker.flush();

      const doneCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '\u{2705}');
      expect(doneCalls).toHaveLength(2);
    });

    it('markAllFailed transitions all tracked messages and sends error message', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markReceived('msg2', 'main@s.whatsapp.net', false);
      tracker.markAllFailed('main@s.whatsapp.net', 'Task crashed');
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '\u{274C}');
      expect(failCalls).toHaveLength(2);
      expect(deps.sendMessage).toHaveBeenCalledWith('main@s.whatsapp.net', '[system] Task crashed');
    });
  });

  describe('serialized sends', () => {
    it('sends reactions in order even when transitions are rapid', async () => {
      const order: string[] = [];
      deps.sendReaction.mockImplementation(async (_jid, _key, emoji) => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        order.push(emoji);
      });

      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');
      tracker.markWorking('msg1');
      tracker.markDone('msg1');

      await tracker.flush();
      expect(order).toEqual(['\u{1F440}', '\u{1F4AD}', '\u{1F504}', '\u{2705}']);
    });
  });

  describe('recover', () => {
    it('marks orphaned non-terminal entries as failed and sends error message', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        { messageId: 'orphan1', chatJid: 'main@s.whatsapp.net', fromMe: false, state: 0, terminal: null, trackedAt: 1000 },
        { messageId: 'orphan2', chatJid: 'main@s.whatsapp.net', fromMe: false, state: 2, terminal: null, trackedAt: 2000 },
        { messageId: 'done1', chatJid: 'main@s.whatsapp.net', fromMe: false, state: 3, terminal: 'done', trackedAt: 3000 },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(persisted);

      await tracker.recover();

      // Should send ❌ reaction for the 2 non-terminal entries only
      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(2);

      // Should send one error message per chatJid
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@s.whatsapp.net',
        '[system] Restarted — reprocessing your message.',
      );
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles missing persistence file gracefully', async () => {
      const fs = await import('fs');
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await tracker.recover(); // should not throw
      expect(deps.sendReaction).not.toHaveBeenCalled();
    });

    it('skips error message when sendErrorMessage is false', async () => {
      const fs = await import('fs');
      const persisted = JSON.stringify([
        { messageId: 'orphan1', chatJid: 'main@s.whatsapp.net', fromMe: false, state: 1, terminal: null, trackedAt: 1000 },
      ]);
      (fs.default.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.default.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(persisted);

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
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');

      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@s.whatsapp.net',
        '[system] Task crashed — retrying.',
      );
    });

    it('does nothing when container is alive', async () => {
      deps.isContainerAlive.mockReturnValue(true);
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');

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
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      // Only 10s elapsed — within 30s grace period
      vi.advanceTimersByTime(10_000);
      tracker.heartbeatCheck();
      await tracker.flush();

      // Only the 👀 reaction, no ❌
      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      expect(deps.sendReaction.mock.calls[0][2]).toBe('👀');
    });

    it('fails RECEIVED messages after grace period when container is dead', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(false);
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      // 31s elapsed — past 30s grace period
      vi.advanceTimersByTime(31_000);
      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@s.whatsapp.net',
        '[system] Task crashed — retrying.',
      );
    });

    it('does NOT fail RECEIVED messages after grace period when container is alive', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true);
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      // 31s elapsed but container is alive — don't fail
      vi.advanceTimersByTime(31_000);
      tracker.heartbeatCheck();
      await tracker.flush();

      expect(deps.sendReaction).toHaveBeenCalledTimes(1);
      expect(deps.sendReaction.mock.calls[0][2]).toBe('👀');
    });

    it('detects stuck messages beyond timeout', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true); // container "alive" but hung

      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');

      // Advance time beyond container timeout (default 1800000ms = 30min)
      vi.advanceTimersByTime(1_800_001);

      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(1);
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'main@s.whatsapp.net',
        '[system] Task timed out — retrying.',
      );
    });

    it('does not timeout messages queued long in RECEIVED before reaching THINKING', async () => {
      vi.useFakeTimers();
      deps.isContainerAlive.mockReturnValue(true);

      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      // Message sits in RECEIVED for longer than CONTAINER_TIMEOUT (queued, waiting for slot)
      vi.advanceTimersByTime(2_000_000);

      // Now container starts — trackedAt resets on THINKING transition
      tracker.markThinking('msg1');

      // Check immediately — should NOT timeout (trackedAt was just reset)
      tracker.heartbeatCheck();
      await tracker.flush();

      const failCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCalls).toHaveLength(0);

      // Advance past CONTAINER_TIMEOUT from THINKING — NOW it should timeout
      vi.advanceTimersByTime(1_800_001);

      tracker.heartbeatCheck();
      await tracker.flush();

      const failCallsAfter = deps.sendReaction.mock.calls.filter((c) => c[2] === '❌');
      expect(failCallsAfter).toHaveLength(1);
    });
  });

  describe('cleanup', () => {
    it('removes terminal messages after delay', async () => {
      vi.useFakeTimers();
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markDone('msg1');

      // Message should still be tracked
      expect(tracker.isTracked('msg1')).toBe(true);

      // Advance past cleanup delay
      vi.advanceTimersByTime(6000);

      expect(tracker.isTracked('msg1')).toBe(false);
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

      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      // First attempt fires immediately
      await vi.advanceTimersByTimeAsync(0);
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

      await tracker.flush();
    });

    it('gives up after max retries', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      deps.sendReaction.mockImplementation(async () => {
        callCount++;
        throw new Error('permanent failure');
      });

      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);

      await vi.advanceTimersByTimeAsync(10_000);
      await tracker.flush();

      expect(callCount).toBe(3); // MAX_RETRIES = 3
    });
  });

  describe('batch transitions', () => {
    it('markThinking can be called on multiple messages independently', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markReceived('msg2', 'main@s.whatsapp.net', false);
      tracker.markReceived('msg3', 'main@s.whatsapp.net', false);

      // Mark all as thinking (simulates batch behavior)
      tracker.markThinking('msg1');
      tracker.markThinking('msg2');
      tracker.markThinking('msg3');

      await tracker.flush();

      const thinkingCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '💭');
      expect(thinkingCalls).toHaveLength(3);
    });

    it('markWorking can be called on multiple messages independently', async () => {
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      tracker.markReceived('msg2', 'main@s.whatsapp.net', false);
      tracker.markThinking('msg1');
      tracker.markThinking('msg2');

      tracker.markWorking('msg1');
      tracker.markWorking('msg2');

      await tracker.flush();

      const workingCalls = deps.sendReaction.mock.calls.filter((c) => c[2] === '🔄');
      expect(workingCalls).toHaveLength(2);
    });
  });
});
