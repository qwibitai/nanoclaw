import { describe, it, expect } from 'vitest';
import {
  chunkDocument,
  smartChunk,
  EMBEDDING_CONTEXT_LIMITS,
} from './memory-chunker.js';
import type { ChunkerConfig } from './memory-chunker.js';

describe('chunkDocument', () => {
  it('returns empty result for empty text', () => {
    const result = chunkDocument('');
    expect(result.chunks).toEqual([]);
    expect(result.chunkCount).toBe(0);
    expect(result.totalOriginalLength).toBe(0);
  });

  it('returns empty result for whitespace-only text', () => {
    const result = chunkDocument('   \n\t  ');
    expect(result.chunks).toEqual([]);
    expect(result.chunkCount).toBe(0);
  });

  it('returns single chunk for short text', () => {
    const text = 'This is a short document.';
    const result = chunkDocument(text);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toBe(text);
    expect(result.chunkCount).toBe(1);
    expect(result.totalOriginalLength).toBe(text.length);
  });

  it('splits long text into multiple chunks', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 100,
      overlapSize: 20,
      minChunkSize: 20,
      semanticSplit: false,
      maxLinesPerChunk: 0,
    };
    const text = 'a'.repeat(300);
    const result = chunkDocument(text, config);
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.totalOriginalLength).toBe(300);
  });

  it('respects maxChunkSize', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 50,
      overlapSize: 10,
      minChunkSize: 10,
      semanticSplit: false,
      maxLinesPerChunk: 0,
    };
    const text = 'word '.repeat(100);
    const result = chunkDocument(text, config);
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it('creates overlapping chunks', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 50,
      overlapSize: 15,
      minChunkSize: 10,
      semanticSplit: false,
      maxLinesPerChunk: 0,
    };
    const text = 'The quick brown fox jumps over the lazy dog again and again forever and ever more text needed.';
    const result = chunkDocument(text, config);
    if (result.chunks.length >= 2) {
      // Consecutive chunks should have some overlapping content
      // (checked via metadata indices)
      for (let i = 1; i < result.metadatas.length; i++) {
        const prev = result.metadatas[i - 1];
        const curr = result.metadatas[i];
        // The start of the current chunk should be before the end of previous
        expect(curr.startIndex).toBeLessThan(prev.endIndex);
      }
    }
  });

  it('prefers sentence boundaries when semanticSplit is enabled', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 80,
      overlapSize: 10,
      minChunkSize: 10,
      semanticSplit: true,
      maxLinesPerChunk: 0,
    };
    const text = 'First sentence here. Second sentence here. Third sentence with more words added.';
    const result = chunkDocument(text, config);
    if (result.chunks.length >= 2) {
      // First chunk should end at a sentence boundary
      expect(result.chunks[0]).toMatch(/\.$/);
    }
  });

  it('handles overlapSize >= maxChunkSize by reducing overlap', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 50,
      overlapSize: 60, // larger than max!
      minChunkSize: 10,
      semanticSplit: false,
      maxLinesPerChunk: 0,
    };
    const text = 'a'.repeat(200);
    // Should not infinite loop
    const result = chunkDocument(text, config);
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  it('metadata indices are consistent', () => {
    const config: ChunkerConfig = {
      maxChunkSize: 100,
      overlapSize: 20,
      minChunkSize: 20,
      semanticSplit: true,
      maxLinesPerChunk: 0,
    };
    const text = 'Hello world. '.repeat(50);
    const result = chunkDocument(text, config);
    for (let i = 0; i < result.chunks.length; i++) {
      const meta = result.metadatas[i];
      expect(meta.length).toBe(result.chunks[i].length);
      expect(meta.endIndex).toBeGreaterThanOrEqual(meta.startIndex);
      expect(meta.startIndex).toBeGreaterThanOrEqual(0);
      expect(meta.endIndex).toBeLessThanOrEqual(text.length);
    }
  });

  it('respects maxLinesPerChunk', () => {
    // Text must exceed maxChunkSize so the chunker enters findSplitEnd,
    // where maxLinesPerChunk is enforced.
    // 40 lines × ~60 chars = ~2400 chars, maxChunkSize=2000 → forces split.
    const config: ChunkerConfig = {
      maxChunkSize: 2000,
      overlapSize: 0,
      minChunkSize: 20,
      semanticSplit: true,
      maxLinesPerChunk: 5,
    };
    const text = Array.from({ length: 40 }, (_, i) =>
      `Line ${i + 1} has enough content to be meaningful and fill up space`,
    ).join('\n');
    const result = chunkDocument(text, config);
    expect(result.chunkCount).toBeGreaterThan(1);
    // First chunk (non-final) should respect the line limit
    const firstChunkLines = result.chunks[0].split('\n').length;
    expect(firstChunkLines).toBeLessThanOrEqual(6); // allow +1 tolerance for boundary
  });
});

describe('smartChunk', () => {
  it('uses model-specific limits when known', () => {
    const text = 'a'.repeat(10000);
    const result = smartChunk(text, 'gemini-embedding-001');
    // gemini-embedding-001 has 2048 limit → chunk size ~1433 (70%)
    expect(result.chunkCount).toBeGreaterThan(1);
  });

  it('falls back to 8192 for unknown models', () => {
    const text = 'a'.repeat(20000);
    const result = smartChunk(text, 'unknown-model');
    expect(result.chunkCount).toBeGreaterThan(1);
  });

  it('handles undefined model', () => {
    const text = 'a'.repeat(20000);
    const result = smartChunk(text);
    expect(result.chunkCount).toBeGreaterThan(1);
  });

  it('returns single chunk for short text', () => {
    const result = smartChunk('Short text here.');
    expect(result.chunkCount).toBe(1);
  });
});

describe('EMBEDDING_CONTEXT_LIMITS', () => {
  it('has entries for common models', () => {
    expect(EMBEDDING_CONTEXT_LIMITS['gemini-embedding-001']).toBe(2048);
    expect(EMBEDDING_CONTEXT_LIMITS['text-embedding-3-small']).toBe(8192);
    expect(EMBEDDING_CONTEXT_LIMITS['nomic-embed-text']).toBe(8192);
  });
});
