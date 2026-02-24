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

    it('skips messages still in RECEIVED state', async () => {
      deps.isContainerAlive.mockReturnValue(false);
      tracker.markReceived('msg1', 'main@s.whatsapp.net', false);
      // Don't advance to THINKING

      tracker.heartbeatCheck();
      await tracker.flush();

      // Only the 👀 reaction, no ❌ (RECEIVED < THINKING, so heartbeat skips it)
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
      vi.useRealTimers();
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
      vi.useRealTimers();
    });
  });
});
