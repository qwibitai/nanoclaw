import { logger } from './logger.js';

/**
 * Character limits for different channels.
 * We use a threshold slightly below the hard limit to leave buffer for
 * markdown formatting, emojis, and edge cases.
 */
export const CHANNEL_LIMITS = {
  telegram: { hard: 4096, threshold: 4000 },
  signal: { hard: 4000, threshold: 3900 },
  whatsapp: { hard: 4096, threshold: 4000 },
  discord: { hard: 2000, threshold: 1900 },
} as const;

export type ChannelType = keyof typeof CHANNEL_LIMITS;

/**
 * Result of checking if we need to chunk.
 */
export interface ChunkCheckResult {
  needsChunk: boolean;
  currentLength: number;
  threshold: number;
}

/**
 * Tracks streaming message length and determines when to chunk.
 *
 * During streaming, we accumulate text in completedText + currentRoundText.
 * This class monitors the total and signals when we're approaching the limit.
 */
export class MessageChunker {
  private channelType: ChannelType;
  private threshold: number;
  private hardLimit: number;

  constructor(channelType: ChannelType) {
    this.channelType = channelType;
    this.hardLimit = CHANNEL_LIMITS[channelType].hard;
    this.threshold = CHANNEL_LIMITS[channelType].threshold;
  }

  /**
   * Check if accumulated text is approaching the threshold.
   * Call this before each edit/send during streaming.
   */
  checkThreshold(
    completedText: string,
    currentRoundText: string,
  ): ChunkCheckResult {
    const totalLength = completedText.length + (currentRoundText.length || 0);
    return {
      needsChunk: totalLength >= this.threshold,
      currentLength: totalLength,
      threshold: this.threshold,
    };
  }

  /**
   * Split text at a sensible boundary if possible.
   * Priority: paragraph > sentence > word > hard slice
   */
  splitAtBoundary(
    text: string,
    maxLen: number,
  ): { first: string; rest: string } {
    if (text.length <= maxLen) {
      return { first: text, rest: '' };
    }

    // Try to find paragraph boundary (double newline)
    const paraBreak = this.findLastBoundary(text, '\n\n', maxLen);
    if (paraBreak) {
      return {
        first: text.slice(0, paraBreak),
        rest: text.slice(paraBreak + 2),
      };
    }

    // Try single newline
    const lineBreak = this.findLastBoundary(text, '\n', maxLen);
    if (lineBreak) {
      return {
        first: text.slice(0, lineBreak),
        rest: text.slice(lineBreak + 1),
      };
    }

    // Try sentence boundary (. ! ? followed by space or end)
    const sentenceEnd = this.findLastSentenceBoundary(text, maxLen);
    if (sentenceEnd) {
      return {
        first: text.slice(0, sentenceEnd + 1),
        rest: text.slice(sentenceEnd + 1).trimStart(),
      };
    }

    // Try word boundary (space)
    const wordBreak = this.findLastBoundary(text, ' ', maxLen);
    if (wordBreak) {
      return {
        first: text.slice(0, wordBreak),
        rest: text.slice(wordBreak + 1),
      };
    }

    // Hard slice as last resort
    logger.warn(
      { length: text.length, maxLen, channel: this.channelType },
      'Message chunker: hard slicing (no boundary found)',
    );
    return { first: text.slice(0, maxLen), rest: text.slice(maxLen) };
  }

  /**
   * Find the last occurrence of a boundary string before maxLen.
   */
  private findLastBoundary(
    text: string,
    boundary: string,
    maxLen: number,
  ): number | null {
    const searchStart = Math.max(0, maxLen - 500); // Look back up to 500 chars
    const slice = text.slice(searchStart, maxLen);
    const idx = slice.lastIndexOf(boundary);
    if (idx === -1) return null;
    return searchStart + idx;
  }

  /**
   * Find the last sentence boundary (. ! ?) before maxLen.
   * Must be followed by space, newline, or end of string.
   */
  private findLastSentenceBoundary(
    text: string,
    maxLen: number,
  ): number | null {
    // Search within the chunk we're considering, plus look at the char after maxLen
    const searchEnd = Math.min(maxLen + 1, text.length);
    const searchStart = Math.max(0, maxLen - 500);
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '.' || char === '!' || char === '?') {
        if (!next || next === ' ' || next === '\n') {
          return i;
        }
      }
    }
    return null;
  }

  /**
   * Get the hard limit for this channel.
   */
  getHardLimit(): number {
    return this.hardLimit;
  }

  /**
   * Get the threshold for this channel.
   */
  getThreshold(): number {
    return this.threshold;
  }
}

/**
 * Detect channel type from jid prefix.
 */
export function detectChannelFromJid(jid: string): ChannelType {
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('signal:')) return 'signal';
  if (jid.startsWith('whatsapp:')) return 'whatsapp';
  if (jid.startsWith('dc:')) return 'discord';
  // Default to telegram for unknown (most common)
  return 'telegram';
}
