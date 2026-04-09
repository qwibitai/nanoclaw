import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageChunker,
  detectChannelFromJid,
  CHANNEL_LIMITS,
} from './message-chunker.js';

describe('MessageChunker', () => {
  let chunker: MessageChunker;

  describe('constructor', () => {
    it('uses correct limits for telegram', () => {
      chunker = new MessageChunker('telegram');
      expect(chunker.getHardLimit()).toBe(4096);
      expect(chunker.getThreshold()).toBe(4000);
    });

    it('uses correct limits for signal', () => {
      chunker = new MessageChunker('signal');
      expect(chunker.getHardLimit()).toBe(4000);
      expect(chunker.getThreshold()).toBe(3900);
    });

    it('uses correct limits for discord', () => {
      chunker = new MessageChunker('discord');
      expect(chunker.getHardLimit()).toBe(2000);
      expect(chunker.getThreshold()).toBe(1900);
    });
  });

  describe('checkThreshold', () => {
    beforeEach(() => {
      chunker = new MessageChunker('telegram');
    });

    it('returns needsChunk false when under threshold', () => {
      const result = chunker.checkThreshold('Short text', '');
      expect(result.needsChunk).toBe(false);
      expect(result.currentLength).toBe(10);
    });

    it('returns needsChunk true when over threshold', () => {
      const longText = 'a'.repeat(4000);
      const result = chunker.checkThreshold(longText, '');
      expect(result.needsChunk).toBe(true);
      expect(result.currentLength).toBe(4000);
    });

    it('combines completedText and currentRoundText for total length', () => {
      const completed = 'a'.repeat(3000);
      const current = 'b'.repeat(1100);
      const result = chunker.checkThreshold(completed, current);
      expect(result.needsChunk).toBe(true);
      expect(result.currentLength).toBe(4100);
    });
  });

  describe('splitAtBoundary', () => {
    beforeEach(() => {
      chunker = new MessageChunker('telegram');
    });

    it('returns whole text if under maxLen', () => {
      const result = chunker.splitAtBoundary('Short text', 100);
      expect(result.first).toBe('Short text');
      expect(result.rest).toBe('');
    });

    it('splits at paragraph boundary when possible', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      const result = chunker.splitAtBoundary(text, 25);
      expect(result.first).toBe('First paragraph.');
      expect(result.rest).toBe('Second paragraph.\n\nThird paragraph.');
    });

    it('splits at newline when no paragraph boundary', () => {
      const text = 'Line one\nLine two\nLine three';
      const result = chunker.splitAtBoundary(text, 15);
      expect(result.first).toBe('Line one');
      expect(result.rest).toBe('Line two\nLine three');
    });

    it('splits at sentence boundary when no newline', () => {
      const text = 'First sentence. Second sentence! Third sentence? Fourth.';
      const result = chunker.splitAtBoundary(text, 30);
      // maxLen=30, the last sentence boundary before that is position 14 (the period)
      expect(result.first).toBe('First sentence.');
      expect(result.rest).toBe('Second sentence! Third sentence? Fourth.');
    });

    it('splits at word boundary when no sentence boundary', () => {
      const text = 'word1 word2 word3 word4 word5';
      const result = chunker.splitAtBoundary(text, 15);
      expect(result.first).toBe('word1 word2');
      expect(result.rest).toBe('word3 word4 word5');
    });

    it('hard slices when no boundary found', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const result = chunker.splitAtBoundary(text, 10);
      expect(result.first).toBe('abcdefghij');
      expect(result.rest).toBe('klmnopqrstuvwxyz');
    });
  });
});

describe('detectChannelFromJid', () => {
  it('detects telegram jid', () => {
    expect(detectChannelFromJid('tg:123456')).toBe('telegram');
    expect(detectChannelFromJid('tg:-1001234567890')).toBe('telegram');
  });

  it('detects signal jid', () => {
    expect(detectChannelFromJid('signal:+15555555555')).toBe('signal');
    expect(detectChannelFromJid('signal:group:abc123')).toBe('signal');
  });

  it('detects whatsapp jid', () => {
    expect(detectChannelFromJid('whatsapp:15555555555@s.whatsapp.net')).toBe(
      'whatsapp',
    );
  });

  it('detects discord jid', () => {
    expect(detectChannelFromJid('dc:123456789')).toBe('discord');
  });

  it('defaults to telegram for unknown', () => {
    expect(detectChannelFromJid('unknown:123')).toBe('telegram');
  });
});
