import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import { trackConversationQuality } from './quality-tracker.js';
import { extractSignal } from './quality-tracker.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('node:fs');
vi.mock('./group-folder.js');
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleMessages(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    sender_name: `user-${i}`,
    content: `Message number ${i}`,
    timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
describe('quality-tracker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    (resolveGroupFolderPath as Mock).mockImplementation(
      (folder: string) => `/tmp/test-groups/${folder}`,
    );

    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.statSync as Mock).mockReturnValue({ size: 100 });
    (fs.mkdirSync as Mock).mockImplementation(() => {});
    (fs.appendFileSync as Mock).mockImplementation(() => {});

    delete process.env.QUALITY_TRACKER_ENABLED;
  });

  afterEach(() => {
    delete process.env.QUALITY_TRACKER_ENABLED;
  });

  // -------------------------------------------------------------------------
  // extractSignal — heuristic tests
  // -------------------------------------------------------------------------
  describe('extractSignal', () => {
    it('should detect positive signal from "thanks"', () => {
      const result = extractSignal([{ content: 'Thanks, that helped!' }]);
      expect(result.signal).toBe('positive');
    });

    it('should detect positive signal from "perfect"', () => {
      const result = extractSignal([
        { content: 'Perfect, exactly what I needed' },
      ]);
      expect(result.signal).toBe('positive');
    });

    it('should detect negative signal from correction', () => {
      const result = extractSignal([
        { content: "That's not what I asked for" },
      ]);
      expect(result.signal).toBe('negative');
    });

    it('should detect negative signal from "wrong"', () => {
      const result = extractSignal([{ content: 'Wrong, try again' }]);
      expect(result.signal).toBe('negative');
    });

    it('should detect negative signal from "you misunderstood"', () => {
      const result = extractSignal([{ content: 'You misunderstood me' }]);
      expect(result.signal).toBe('negative');
    });

    it('should return neutral for ordinary messages', () => {
      const result = extractSignal([
        { content: 'Can you check the deployment status?' },
      ]);
      expect(result.signal).toBe('neutral');
    });

    it('should prioritize negative over positive when both present', () => {
      // Last message is negative — should win
      const result = extractSignal([
        { content: 'Thanks for trying' },
        { content: "That's not right, try again" },
      ]);
      expect(result.signal).toBe('negative');
    });

    it('should check most recent messages first', () => {
      // Last message is positive — should win over earlier neutral
      const result = extractSignal([
        { content: 'Set up the database' },
        { content: 'Check the config' },
        { content: 'Great, looks good!' },
      ]);
      expect(result.signal).toBe('positive');
    });

    it('should return neutral for empty messages', () => {
      const result = extractSignal([]);
      expect(result.signal).toBe('neutral');
    });
  });

  // -------------------------------------------------------------------------
  // trackConversationQuality — integration tests
  // -------------------------------------------------------------------------
  describe('trackConversationQuality', () => {
    it('should append JSONL entry for a conversation', async () => {
      await trackConversationQuality('main', sampleMessages(3), ['Bot reply']);

      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      const written = (fs.appendFileSync as Mock).mock.calls[0][1] as string;

      // Should be valid JSON ending with newline
      expect(written).toMatch(/\n$/);
      const parsed = JSON.parse(written.trim());

      expect(parsed.groupFolder).toBe('main');
      expect(parsed.userMessages).toHaveLength(3);
      expect(parsed.botResponses).toEqual(['Bot reply']);
      expect(['positive', 'negative', 'neutral']).toContain(parsed.signal);
      expect(parsed.timestamp).toBeTruthy();
    });

    it('should scrub credentials from logged content', async () => {
      const msgs = [
        {
          sender_name: 'user',
          content: 'My key is sk-abc123secretkey and ghp_1234567890abcdef',
          timestamp: new Date().toISOString(),
        },
      ];

      await trackConversationQuality('main', msgs, ['Got it']);

      const written = (fs.appendFileSync as Mock).mock.calls[0][1] as string;
      expect(written).not.toContain('sk-abc123secretkey');
      expect(written).not.toContain('ghp_1234567890abcdef');
    });

    it('should skip when QUALITY_TRACKER_ENABLED=false', async () => {
      process.env.QUALITY_TRACKER_ENABLED = 'false';

      await trackConversationQuality('main', sampleMessages(3), ['Reply']);

      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should skip for empty user messages', async () => {
      await trackConversationQuality('main', [], ['Reply']);

      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should skip when file exceeds 1MB', async () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.statSync as Mock).mockReturnValue({ size: 1024 * 1024 }); // exactly 1MB

      await trackConversationQuality('main', sampleMessages(3), ['Reply']);

      expect(fs.appendFileSync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should use resolveGroupFolderPath for file paths', async () => {
      await trackConversationQuality('test-group', sampleMessages(2), [
        'Reply',
      ]);

      expect(resolveGroupFolderPath).toHaveBeenCalledWith('test-group');
    });

    it('should never throw (graceful error handling)', async () => {
      (resolveGroupFolderPath as Mock).mockImplementation(() => {
        throw new Error('Path resolution failed');
      });

      await expect(
        trackConversationQuality('main', sampleMessages(2), ['Reply']),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalled();
    });

    it('should truncate long messages to 2000 chars', async () => {
      const longMsg = 'x'.repeat(5000);
      const msgs = [
        {
          sender_name: 'user',
          content: longMsg,
          timestamp: new Date().toISOString(),
        },
      ];

      await trackConversationQuality('main', msgs, [longMsg]);

      const written = (fs.appendFileSync as Mock).mock.calls[0][1] as string;
      const parsed = JSON.parse(written.trim());

      expect(parsed.userMessages[0].content.length).toBeLessThanOrEqual(2000);
      expect(parsed.botResponses[0].length).toBeLessThanOrEqual(2000);
    });

    it('should create store directory if missing', async () => {
      await trackConversationQuality('main', sampleMessages(2), ['Reply']);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('store'),
        { recursive: true },
      );
    });
  });
});
