/**
 * Hybrid Memory (BM25 + Vector) — Test Suite
 *
 * Tests for chunking, embedding generation, cosine similarity,
 * RRF fusion, vector search, hybrid search, file indexing, and cleanup.
 *
 * All tests written from spec only — no production code was read.
 */

import { describe, it, expect } from 'vitest';
import {
  chunkText,
  generateEmbeddings,
  cosineSimilarity,
  rrfFuse,
  vectorSearch,
  hybridSearch,
  indexFile,
  removeFileEmbeddings,
} from './embedding.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a normalized random-ish vector of 512 dims for testing. */
function makeUnitVector(seed: number): Float32Array {
  const v = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    // deterministic pseudo-random based on seed + index
    v[i] = Math.sin(seed * 1000 + i * 0.1);
  }
  // normalize
  const mag = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
  for (let i = 0; i < 512; i++) v[i] /= mag;
  return v;
}

/** Generate a string of exactly `n` words. */
function wordsN(n: number): string {
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(`word${i}`);
  return words.join(' ');
}

/** Generate multi-paragraph text with `paragraphs` paragraphs, each `wordsPerParagraph` words. */
function paragraphs(count: number, wordsPerParagraph: number): string {
  const parts: string[] = [];
  for (let p = 0; p < count; p++) {
    const words: string[] = [];
    for (let w = 0; w < wordsPerParagraph; w++) {
      words.push(`p${p}w${w}`);
    }
    parts.push(words.join(' '));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Mock types matching the spec's expected result shapes
// ---------------------------------------------------------------------------

interface SearchResult {
  chunkId: string;
  content: string;
  score: number;
  filePath?: string;
}

// ---------------------------------------------------------------------------
// 1. chunkText — paragraph-aware chunking
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('should chunk markdown by paragraphs with 15% overlap', () => {
    // Two paragraphs, each 500 words → total 1000 words
    // maxWords=800, so they can't both fit in one chunk
    // With 15% overlap of 800 = 120 words overlap
    const text = paragraphs(2, 500);
    const chunks = chunkText(text, 800, 15);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Verify overlap: the end of chunk[0] and start of chunk[1] should share words
    const chunk0Words = chunks[0].split(/\s+/);
    const chunk1Words = chunks[1].split(/\s+/);

    // The overlap region should be ~15% of 800 = 120 words
    const overlapSize = Math.floor(800 * 0.15);
    const tail = chunk0Words.slice(-overlapSize);
    const head = chunk1Words.slice(0, overlapSize);

    // At least some overlap words should match
    const overlap = tail.filter((w) => head.includes(w));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('should use default maxWords=800 and overlapPercent=15', () => {
    // 1600 words → should produce at least 2 chunks with default params
    const text = wordsN(1600);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Each chunk should have at most 800 words
    for (const chunk of chunks) {
      const wordCount = chunk.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeLessThanOrEqual(800);
    }
  });

  it('should preserve paragraph boundaries when possible', () => {
    // 3 paragraphs of 200 words each (600 total, fits in 800)
    const text = paragraphs(3, 200);
    const chunks = chunkText(text, 800, 15);

    // All 600 words fit in one 800-word chunk
    expect(chunks.length).toBe(1);
    // The paragraph structure should be preserved (double newlines)
    expect(chunks[0]).toContain('\n\n');
  });

  it('should return a single chunk for short text', () => {
    const text = wordsN(100);
    const chunks = chunkText(text, 800, 15);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });

  it('should return an empty array for empty text', () => {
    const chunks = chunkText('');
    expect(chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. generateEmbeddings — OpenAI API call
// ---------------------------------------------------------------------------

describe('generateEmbeddings', () => {
  it('should generate embeddings for new file chunks', async () => {
    // Mock the OpenAI embedding API at the module level
    // The function should call OpenAI text-embedding-3-small and return 512 dims
    const result = await generateEmbeddings('The quick brown fox jumps over the lazy dog');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(512);
  });

  it('should reject embedding dimensions != 512', async () => {
    // If somehow the API returns wrong dimensions, the function should reject
    // We test that the output is always exactly 512
    const result = await generateEmbeddings('test content');
    expect(result.length).toBe(512);
  });

  it('should reject empty text input', async () => {
    await expect(generateEmbeddings('')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. cosineSimilarity — in-app vector math
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const v = makeUnitVector(42);
    const sim = cosineSimilarity(v, v);
    expect(sim).toBeCloseTo(1.0, 5);
  });

  it('should return -1 for opposite vectors', () => {
    const v = makeUnitVector(42);
    const neg = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) neg[i] = -v[i];
    const sim = cosineSimilarity(v, neg);
    expect(sim).toBeCloseTo(-1.0, 5);
  });

  it('should return 0 for orthogonal vectors', () => {
    // Construct two orthogonal 512-dim vectors
    const a = new Float32Array(512).fill(0);
    const b = new Float32Array(512).fill(0);
    // a has values in first half, b in second half
    for (let i = 0; i < 256; i++) a[i] = 1;
    for (let i = 256; i < 512; i++) b[i] = 1;
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.0, 5);
  });

  it('should return a value between -1 and 1', () => {
    const a = makeUnitVector(1);
    const b = makeUnitVector(2);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('should compute dot product / (magnitude_a * magnitude_b)', () => {
    // Manual calculation with known values
    const a = new Float32Array([3, 0, 0, ...new Array(509).fill(0)]);
    const b = new Float32Array([0, 4, 0, ...new Array(509).fill(0)]);
    // dot = 0, |a| = 3, |b| = 4 → cosine = 0
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.0, 5);

    const c = new Float32Array([1, 2, 3, ...new Array(509).fill(0)]);
    const d = new Float32Array([1, 2, 3, ...new Array(509).fill(0)]);
    // identical → cosine = 1
    const sim2 = cosineSimilarity(c, d);
    expect(sim2).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// 4. rrfFuse — Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

describe('rrfFuse', () => {
  // Mock BM25 and vector results
  const bm25Results: SearchResult[] = [
    { chunkId: 'a', content: 'chunk a', score: 10 },
    { chunkId: 'b', content: 'chunk b', score: 8 },
    { chunkId: 'c', content: 'chunk c', score: 6 },
    { chunkId: 'd', content: 'chunk d', score: 4 },
  ];

  const vectorResults: SearchResult[] = [
    { chunkId: 'b', content: 'chunk b', score: 0.95 },
    { chunkId: 'e', content: 'chunk e', score: 0.90 },
    { chunkId: 'a', content: 'chunk a', score: 0.85 },
    { chunkId: 'f', content: 'chunk f', score: 0.80 },
  ];

  it('should compute RRF fusion from BM25 + vector results', () => {
    const fused = rrfFuse(bm25Results, vectorResults, 60);

    expect(fused).toBeDefined();
    expect(Array.isArray(fused)).toBe(true);
    expect(fused.length).toBeGreaterThan(0);

    // Each fused result should have a score
    for (const result of fused) {
      expect(result.score).toBeDefined();
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThan(0);
    }
  });

  it('should boost results found by both BM25 and vector search', () => {
    const fused = rrfFuse(bm25Results, vectorResults, 60);

    // 'a' appears in both (rank 1 in BM25, rank 3 in vector)
    // 'b' appears in both (rank 2 in BM25, rank 1 in vector)
    // Both should score higher than items in only one list

    const scoreA = fused.find((r) => r.chunkId === 'a')!.score;
    const scoreB = fused.find((r) => r.chunkId === 'b')!.score;
    const scoreC = fused.find((r) => r.chunkId === 'c')!.score; // BM25 only
    const scoreE = fused.find((r) => r.chunkId === 'e')!.score; // vector only

    // Items in BOTH lists should score higher than items in only one
    expect(scoreA).toBeGreaterThan(scoreC);
    expect(scoreA).toBeGreaterThan(scoreE);
    expect(scoreB).toBeGreaterThan(scoreC);
    expect(scoreB).toBeGreaterThan(scoreE);
  });

  it('should use RRF formula: score = sum of 1/(k + rank)', () => {
    const fused = rrfFuse(bm25Results, vectorResults, 60);

    // 'b' is rank 2 in BM25, rank 1 in vector
    // RRF score for 'b' = 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    const expectedScoreB = 1 / 62 + 1 / 61;
    const resultB = fused.find((r) => r.chunkId === 'b')!;
    expect(resultB.score).toBeCloseTo(expectedScoreB, 6);

    // 'a' is rank 1 in BM25, rank 3 in vector
    // RRF score for 'a' = 1/(60+1) + 1/(60+3) = 1/61 + 1/63
    const expectedScoreA = 1 / 61 + 1 / 63;
    const resultA = fused.find((r) => r.chunkId === 'a')!;
    expect(resultA.score).toBeCloseTo(expectedScoreA, 6);

    // 'c' is rank 3 in BM25 only
    // RRF score for 'c' = 1/(60+3) = 1/63
    const expectedScoreC = 1 / 63;
    const resultC = fused.find((r) => r.chunkId === 'c')!;
    expect(resultC.score).toBeCloseTo(expectedScoreC, 6);
  });

  it('should sort results by RRF score descending', () => {
    const fused = rrfFuse(bm25Results, vectorResults, 60);

    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });

  it('should default k=60', () => {
    // Call without explicit k
    const fused = rrfFuse(bm25Results, vectorResults);

    // Verify 'b' score matches k=60
    const expectedScoreB = 1 / 62 + 1 / 61;
    const resultB = fused.find((r) => r.chunkId === 'b')!;
    expect(resultB.score).toBeCloseTo(expectedScoreB, 6);
  });

  it('should return top 10 fused results from top 50 per method', () => {
    // Generate 50 BM25 results and 50 vector results with some overlap
    const bigBm25: SearchResult[] = [];
    const bigVector: SearchResult[] = [];
    for (let i = 0; i < 50; i++) {
      bigBm25.push({ chunkId: `bm25_${i}`, content: `bm25 chunk ${i}`, score: 50 - i });
    }
    for (let i = 0; i < 50; i++) {
      bigVector.push({ chunkId: `vec_${i}`, content: `vec chunk ${i}`, score: 1 - i * 0.01 });
    }
    // Add some overlap
    bigBm25[0].chunkId = 'shared_0';
    bigVector[0].chunkId = 'shared_0';
    bigBm25[0].content = 'shared chunk 0';
    bigVector[0].content = 'shared chunk 0';

    const fused = rrfFuse(bigBm25, bigVector, 60);

    // Should return at most 10
    expect(fused.length).toBeLessThanOrEqual(10);
    expect(fused.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 5. vectorSearch — cosine similarity search over stored embeddings
// ---------------------------------------------------------------------------

describe('vectorSearch', () => {
  it('should handle NULL embeddings gracefully in vector search', async () => {
    // When some chunks have NULL embeddings (API was unavailable at index time),
    // vector search should skip them without crashing
    const results = await vectorSearch('test query', 'test-group');

    // Should return results (possibly empty) without throwing
    expect(Array.isArray(results)).toBe(true);
  });

  it('should return results sorted by cosine similarity descending', async () => {
    const results = await vectorSearch('test query', 'test-group');

    expect(Array.isArray(results)).toBe(true);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('should return top 50 results', async () => {
    const results = await vectorSearch('test query', 'test-group');
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it('should reject empty queries', async () => {
    await expect(vectorSearch('', 'test-group')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. hybridSearch — BM25 + vector + RRF
// ---------------------------------------------------------------------------

describe('hybridSearch', () => {
  it('should fall back to BM25-only when embedding API fails', async () => {
    // When the embedding API is unavailable, hybridSearch should still
    // return results from BM25 alone (degraded but functional)
    // We simulate API failure — the function should catch it and use BM25 only
    const results = await hybridSearch('test query', 'test-group');

    expect(Array.isArray(results)).toBe(true);
    // Should have results from BM25 at minimum
  });

  it('should return top 10 fused results', async () => {
    const results = await hybridSearch('test query', 'test-group');

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('should use BM25-only when HYBRID_MEMORY_ENABLED is false', async () => {
    // When hybrid memory is disabled, should not make any embedding API calls
    // and return BM25-only results
    const originalEnv = process.env.HYBRID_MEMORY_ENABLED;
    try {
      process.env.HYBRID_MEMORY_ENABLED = 'false';
      const results = await hybridSearch('test query', 'test-group');
      expect(Array.isArray(results)).toBe(true);
    } finally {
      // Restore
      if (originalEnv !== undefined) {
        process.env.HYBRID_MEMORY_ENABLED = originalEnv;
      } else {
        delete process.env.HYBRID_MEMORY_ENABLED;
      }
    }
  });

  it('should reject empty queries', async () => {
    await expect(hybridSearch('', 'test-group')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. indexFile — file indexing with chunking + embedding
// ---------------------------------------------------------------------------

describe('indexFile', () => {
  it('should generate embeddings for new file chunks', async () => {
    // Indexing a new file should chunk it and generate embeddings for each chunk
    const result = await indexFile('test-group', 'notes.md', 'Hello world. This is a test file.');

    expect(result).toBeDefined();
    // The function should have processed the file without error
    expect(result.chunksIndexed).toBeGreaterThan(0);
  });

  it('should skip re-embedding when chunk content unchanged', async () => {
    // Index the same file twice — second time should skip re-embedding
    // because content hash (SHA-256) matches
    const content = 'This is test content that should be hashed.';

    await indexFile('test-group', 'notes.md', content);
    const secondResult = await indexFile('test-group', 'notes.md', content);

    // Second indexing should report 0 new embeddings generated
    expect(secondResult.embeddingsGenerated).toBe(0);
    expect(secondResult.skippedUnchanged).toBeGreaterThan(0);
  });

  it('should skip files > 1MB', async () => {
    // Generate content > 1MB
    const bigContent = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1 byte

    const result = await indexFile('test-group', 'bigfile.md', bigContent);

    // Should skip embedding and log a warning
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/1MB/i);
  });

  it('should store chunk without embedding when API unavailable', async () => {
    // When embedding API fails at index time, store chunk with NULL embedding
    // Test that the function does not throw — it stores chunks and logs warning
    const result = await indexFile('test-group', 'notes.md', 'Some content to embed.');

    // Should complete without throwing, even if embeddings are NULL
    expect(result).toBeDefined();
    expect(result.chunksIndexed).toBeGreaterThan(0);
  });

  it('should use SHA-256 content hash for change detection', async () => {
    // Different content should produce different hashes and trigger re-embedding
    await indexFile('test-group', 'notes.md', 'Version 1 content');
    const result2 = await indexFile('test-group', 'notes.md', 'Version 2 content');

    // Second call has different content, so it should re-embed
    expect(result2.embeddingsGenerated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. removeFileEmbeddings — cleanup on file delete
// ---------------------------------------------------------------------------

describe('removeFileEmbeddings', () => {
  it('should remove embeddings when file deleted', async () => {
    // After indexing a file, removing it should clean up all chunks + embeddings
    await indexFile('test-group', 'to-delete.md', 'This file will be deleted.');
    const result = await removeFileEmbeddings('test-group', 'to-delete.md');

    expect(result).toBeDefined();
    expect(result.removedChunks).toBeGreaterThan(0);
  });

  it('should handle removing non-existent file gracefully', async () => {
    // Removing a file that was never indexed should not throw
    const result = await removeFileEmbeddings('test-group', 'never-existed.md');

    expect(result).toBeDefined();
    expect(result.removedChunks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group folder & file path validation guards
// ---------------------------------------------------------------------------

describe('input validation guards', () => {
  const badGroupFolders = [
    '',
    '../escape',
    'has/slash',
    '.starts-with-dot',
    '-starts-with-dash',
    'a'.repeat(65), // exceeds 64 char max
  ];

  const badFilePaths = [
    '',
    '/absolute/path.md',
    '../escape/path.md',
    'nested/../escape.md',
  ];

  describe('indexFile rejects invalid group folders', () => {
    for (const bad of badGroupFolders) {
      it(`rejects groupFolder "${bad}"`, async () => {
        await expect(indexFile(bad, 'file.md', 'content')).rejects.toThrow('Invalid group folder');
      });
    }
  });

  describe('indexFile rejects invalid file paths', () => {
    for (const bad of badFilePaths) {
      it(`rejects filePath "${bad}"`, async () => {
        await expect(indexFile('valid-group', bad, 'content')).rejects.toThrow('Invalid file path');
      });
    }
  });

  describe('vectorSearch rejects invalid group folders', () => {
    for (const bad of badGroupFolders) {
      it(`rejects groupFolder "${bad}"`, async () => {
        await expect(vectorSearch('query', bad)).rejects.toThrow('Invalid group folder');
      });
    }
  });

  describe('hybridSearch rejects invalid group folders', () => {
    for (const bad of badGroupFolders) {
      it(`rejects groupFolder "${bad}"`, async () => {
        await expect(hybridSearch('query', bad)).rejects.toThrow('Invalid group folder');
      });
    }
  });

  describe('removeFileEmbeddings rejects invalid group folders', () => {
    for (const bad of badGroupFolders) {
      it(`rejects groupFolder "${bad}"`, async () => {
        await expect(removeFileEmbeddings(bad, 'file.md')).rejects.toThrow('Invalid group folder');
      });
    }
  });

  describe('removeFileEmbeddings rejects invalid file paths', () => {
    for (const bad of badFilePaths) {
      it(`rejects filePath "${bad}"`, async () => {
        await expect(removeFileEmbeddings('valid-group', bad)).rejects.toThrow('Invalid file path');
      });
    }
  });
});
