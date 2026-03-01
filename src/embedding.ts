/**
 * Hybrid Memory — BM25 + Vector Search with RRF Fusion
 *
 * Provides chunking, embedding generation (OpenAI text-embedding-3-small),
 * cosine similarity, RRF fusion, vector search, hybrid search,
 * file indexing, and cleanup.
 */

import { createHash } from 'crypto';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  chunkId: string;
  content: string;
  score: number;
  filePath?: string;
}

interface StoredChunk {
  id: string;
  groupFolder: string;
  filePath: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  embedding: Buffer | null;
}

interface IndexResult {
  chunksIndexed: number;
  embeddingsGenerated: number;
  skippedUnchanged: number;
  skipped?: boolean;
  reason?: string;
}

interface RemoveResult {
  removedChunks: number;
}

// ---------------------------------------------------------------------------
// Persistence adapter — optional SQLite backing for the in-memory store
// ---------------------------------------------------------------------------

export interface EmbeddingPersistence {
  loadChunksForGroup(groupFolder: string): StoredChunk[];
  loadChunksForFile(groupFolder: string, filePath: string): StoredChunk[];
  saveChunk(chunk: StoredChunk): void;
  removeChunksForFile(groupFolder: string, filePath: string): number;
  getChunkCount(): number;
}

let persistence: EmbeddingPersistence | null = null;

/**
 * Set an optional persistence adapter (e.g., SQLite via db.ts).
 * When set, all writes are persisted and initial loads hydrate from storage.
 * When not set, the store is purely in-memory (test mode).
 */
export function setEmbeddingPersistence(p: EmbeddingPersistence | null): void {
  persistence = p;
}

/**
 * Hydrate the in-memory store from the persistence layer for a group.
 * Call this at startup for each active group.
 */
export function loadGroupFromPersistence(groupFolder: string): number {
  if (!persistence) return 0;
  const chunks = persistence.loadChunksForGroup(groupFolder);
  for (const chunk of chunks) {
    store.set(storeKey(chunk.groupFolder, chunk.filePath, chunk.chunkIndex), chunk);
  }
  return chunks.length;
}

// ---------------------------------------------------------------------------
// In-memory store (write-through to persistence when available)
// ---------------------------------------------------------------------------

const store: Map<string, StoredChunk> = new Map();

function storeKey(groupFolder: string, filePath: string, chunkIndex: number): string {
  return `${groupFolder}::${filePath}::${chunkIndex}`;
}

function getChunksForFile(groupFolder: string, filePath: string): StoredChunk[] {
  const results: StoredChunk[] = [];
  const prefix = `${groupFolder}::${filePath}::`;
  for (const [key, chunk] of store) {
    if (key.startsWith(prefix)) {
      results.push(chunk);
    }
  }
  return results;
}

function getChunksForGroup(groupFolder: string): StoredChunk[] {
  const results: StoredChunk[] = [];
  const prefix = `${groupFolder}::`;
  for (const [key, chunk] of store) {
    if (key.startsWith(prefix)) {
      results.push(chunk);
    }
  }
  return results;
}

function removeChunksForFile(groupFolder: string, filePath: string): number {
  let removed = 0;
  const prefix = `${groupFolder}::${filePath}::`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed++;
    }
  }
  // Also remove from persistence
  if (persistence) {
    persistence.removeChunksForFile(groupFolder, filePath);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSIONS = 512;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_EMBEDDING_INPUT_CHARS = 32_000; // ~8K tokens — safety cap for direct callers
const MAX_STORE_SIZE = 10_000; // Max chunks in memory — prevents OOM on 4GB VPS
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Group folder validation — prevents path traversal and cross-group pollution
const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertValidGroupFolder(folder: string): void {
  if (!folder || !GROUP_FOLDER_PATTERN.test(folder) || folder.includes('..') || folder.includes('/')) {
    throw new Error(`Invalid group folder: ${folder}`);
  }
}

function normalizeFilePath(filePath: string): string {
  // Reject absolute paths and path traversal
  if (!filePath || filePath.startsWith('/') || filePath.includes('..')) {
    throw new Error(`Invalid file path: ${filePath}`);
  }
  return filePath;
}

function isHybridEnabled(): boolean {
  const val = process.env.HYBRID_MEMORY_ENABLED;
  // Default to true unless explicitly set to 'false'
  return val !== 'false';
}

// ---------------------------------------------------------------------------
// 1. chunkText — paragraph-aware chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks of at most `maxWords` words with `overlapPercent`%
 * overlap. Respects paragraph boundaries (double newlines) when possible.
 */
export function chunkText(
  text: string,
  maxWords: number = 800,
  overlapPercent: number = 15,
): string[] {
  if (!text || text.trim().length === 0) return [];

  const overlapWords = Math.floor(maxWords * (overlapPercent / 100));

  // Split into paragraphs first
  const paragraphs = text.split(/\n\n+/);

  // Build chunks respecting paragraph boundaries
  const chunks: string[] = [];
  let currentParagraphs: string[] = [];
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).filter(Boolean);
    const paraWordCount = paraWords.length;

    if (currentWordCount + paraWordCount <= maxWords) {
      // This paragraph fits in the current chunk
      currentParagraphs.push(para);
      currentWordCount += paraWordCount;
    } else {
      // Current chunk is full (or would overflow)
      if (currentParagraphs.length > 0) {
        chunks.push(currentParagraphs.join('\n\n'));
      }

      // If a single paragraph exceeds maxWords, split it by words
      if (paraWordCount > maxWords) {
        const words = paraWords;
        let start = 0;
        // If we had previous content, carry overlap
        if (chunks.length > 0) {
          const prevChunkWords = chunks[chunks.length - 1].split(/\s+/).filter(Boolean);
          const overlapStart = Math.max(0, prevChunkWords.length - overlapWords);
          const overlapContent = prevChunkWords.slice(overlapStart);
          // Start new chunk with overlap from previous
          const firstChunkWords = [...overlapContent, ...words.slice(0, maxWords - overlapContent.length)];
          chunks[chunks.length] = firstChunkWords.join(' ');
          start = maxWords - overlapContent.length;
        }

        while (start < words.length) {
          const overlapStart = Math.max(0, start - overlapWords);
          const chunkWords = words.slice(overlapStart, overlapStart + maxWords);
          chunks.push(chunkWords.join(' '));
          start = overlapStart + maxWords;
        }
        currentParagraphs = [];
        currentWordCount = 0;
      } else {
        // Start new chunk with overlap from previous chunk
        if (chunks.length > 0 && overlapWords > 0) {
          const prevChunkWords = chunks[chunks.length - 1].split(/\s+/).filter(Boolean);
          const overlapStart = Math.max(0, prevChunkWords.length - overlapWords);
          const overlapContent = prevChunkWords.slice(overlapStart).join(' ');
          currentParagraphs = [overlapContent, para];
          currentWordCount = overlapWords + paraWordCount;
        } else {
          currentParagraphs = [para];
          currentWordCount = paraWordCount;
        }
      }
    }
  }

  // Flush remaining
  if (currentParagraphs.length > 0) {
    chunks.push(currentParagraphs.join('\n\n'));
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// 2. generateEmbeddings — OpenAI API call (or deterministic fallback)
// ---------------------------------------------------------------------------

/**
 * Generate a 512-dimensional embedding for the given text.
 * Uses OpenAI text-embedding-3-small API. Falls back to a deterministic
 * hash-based embedding when the API key is not available.
 */
export async function generateEmbeddings(text: string): Promise<Float32Array> {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot generate embeddings for empty text');
  }

  // P1-2: Input length validation — prevent oversized inputs to paid API
  if (text.length > MAX_EMBEDDING_INPUT_CHARS) {
    logger.warn({ length: text.length, max: MAX_EMBEDDING_INPUT_CHARS }, 'Embedding input too large, truncating');
    text = text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  // P1-3: SSRF protection — validate base URL uses HTTPS
  if (apiKey && baseUrl !== 'https://api.openai.com/v1') {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:') {
        logger.warn({ baseUrl }, 'Embedding API base URL must use HTTPS, using fallback');
        return deterministicEmbedding(text);
      }
    } catch {
      logger.warn({ baseUrl }, 'Invalid embedding API base URL, using fallback');
      return deterministicEmbedding(text);
    }
  }

  if (apiKey) {
    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!response.ok) {
        // P1-1: Sanitize error body — truncate and strip potential secrets
        const rawBody = await response.text().catch(() => 'unknown');
        const sanitized = rawBody.slice(0, 500).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
        throw new Error(`Embedding API error ${response.status}: ${sanitized}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      const embedding = data.data[0].embedding;
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding dimensions mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
        );
      }

      return new Float32Array(embedding);
    } catch (err) {
      logger.warn({ err }, 'Embedding API call failed, using fallback');
    }
  }

  // Deterministic fallback: hash-based embedding for testing/offline
  return deterministicEmbedding(text);
}

/**
 * Generate a deterministic embedding from text content using SHA-256.
 * Used as a fallback when the OpenAI API is unavailable.
 */
function deterministicEmbedding(text: string): Float32Array {
  const result = new Float32Array(EMBEDDING_DIMENSIONS);
  // Use multiple hash rounds to fill 512 dimensions
  const hashBytes = EMBEDDING_DIMENSIONS * 4; // 4 bytes per float32
  let hashInput = text;
  const allBytes: number[] = [];

  while (allBytes.length < hashBytes) {
    const hash = createHash('sha256').update(hashInput).digest();
    for (let i = 0; i < hash.length; i++) {
      allBytes.push(hash[i]);
    }
    hashInput = hash.toString('hex') + text;
  }

  // Convert bytes to float32 values between -1 and 1
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    const byte = allBytes[i];
    result[i] = (byte / 127.5) - 1;
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      result[i] /= magnitude;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. cosineSimilarity — in-app vector math
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * Returns dot(a,b) / (|a| * |b|), a value between -1 and 1.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;

  return dot / (magA * magB);
}

// ---------------------------------------------------------------------------
// 4. rrfFuse — Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * Fuse BM25 and vector search results using Reciprocal Rank Fusion.
 * RRF score = sum of 1/(k + rank) for each list the result appears in.
 * Returns top 10 results sorted by fused score descending.
 */
export function rrfFuse(
  bm25Results: SearchResult[],
  vectorResults: SearchResult[],
  k: number = 60,
): SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();

  // Process BM25 results (rank is 1-based)
  for (let i = 0; i < bm25Results.length; i++) {
    const rank = i + 1;
    const rrfScore = 1 / (k + rank);
    const result = bm25Results[i];
    const existing = scores.get(result.chunkId);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.chunkId, {
        score: rrfScore,
        result: { ...result },
      });
    }
  }

  // Process vector results (rank is 1-based)
  for (let i = 0; i < vectorResults.length; i++) {
    const rank = i + 1;
    const rrfScore = 1 / (k + rank);
    const result = vectorResults[i];
    const existing = scores.get(result.chunkId);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(result.chunkId, {
        score: rrfScore,
        result: { ...result },
      });
    }
  }

  // Sort by fused score descending, take top 10
  const fused = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score, result }) => ({
      ...result,
      score,
    }));

  return fused;
}

// ---------------------------------------------------------------------------
// 5. vectorSearch — cosine similarity search over stored embeddings
// ---------------------------------------------------------------------------

/**
 * Search stored embeddings for chunks most similar to the query.
 * Returns top `topK` results sorted by cosine similarity descending.
 */
export async function vectorSearch(
  query: string,
  groupFolder: string,
  topK: number = 50,
): Promise<SearchResult[]> {
  assertValidGroupFolder(groupFolder);

  if (!query || query.trim().length === 0) {
    throw new Error('Cannot search with empty query');
  }

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await generateEmbeddings(query);
  } catch (err) {
    logger.warn({ err }, 'Failed to generate query embedding for vector search');
    return [];
  }

  const chunks = getChunksForGroup(groupFolder);
  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    // Skip chunks with NULL embeddings
    if (!chunk.embedding) continue;

    const chunkEmbedding = bufferToFloat32Array(chunk.embedding);
    if (chunkEmbedding.length !== EMBEDDING_DIMENSIONS) continue;

    const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

    results.push({
      chunkId: chunk.id,
      content: chunk.content,
      score: similarity,
      filePath: chunk.filePath,
    });
  }

  // Sort by similarity descending, take top K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ---------------------------------------------------------------------------
// 6. hybridSearch — BM25 + vector + RRF
// ---------------------------------------------------------------------------

/**
 * Perform hybrid search: BM25 + vector with RRF fusion.
 * Falls back to BM25-only when embedding API fails or
 * HYBRID_MEMORY_ENABLED is false.
 */
export async function hybridSearch(
  query: string,
  groupFolder: string,
  topK: number = 10,
): Promise<SearchResult[]> {
  assertValidGroupFolder(groupFolder);

  if (!query || query.trim().length === 0) {
    throw new Error('Cannot search with empty query');
  }

  // BM25 search (simple in-memory text matching as fallback)
  const bm25Results = bm25Search(query, groupFolder);

  // If hybrid memory is disabled, return BM25-only
  if (!isHybridEnabled()) {
    return bm25Results.slice(0, topK);
  }

  // Try vector search
  let vecResults: SearchResult[];
  try {
    vecResults = await vectorSearch(query, groupFolder, 50);
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, falling back to BM25-only');
    return bm25Results.slice(0, topK);
  }

  // If vector search returned nothing, use BM25-only
  if (vecResults.length === 0) {
    return bm25Results.slice(0, topK);
  }

  // Fuse with RRF
  const fused = rrfFuse(bm25Results.slice(0, 50), vecResults.slice(0, 50), 60);
  return fused.slice(0, topK);
}

/**
 * Simple BM25-like text search over stored chunks.
 * Scores based on term frequency of query words in chunk content.
 */
function bm25Search(query: string, groupFolder: string): SearchResult[] {
  const chunks = getChunksForGroup(groupFolder);
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (queryTerms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    const contentLower = chunk.content.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      // Count occurrences
      let idx = 0;
      let count = 0;
      while ((idx = contentLower.indexOf(term, idx)) !== -1) {
        count++;
        idx += term.length;
      }
      score += count;
    }

    if (score > 0) {
      results.push({
        chunkId: chunk.id,
        content: chunk.content,
        score,
        filePath: chunk.filePath,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// 7. indexFile — file indexing with chunking + embedding
// ---------------------------------------------------------------------------

/**
 * Index a file: chunk it, compute content hashes, generate embeddings,
 * and store in the in-memory store.
 */
export async function indexFile(
  groupFolder: string,
  filePath: string,
  content: string,
): Promise<IndexResult> {
  assertValidGroupFolder(groupFolder);
  filePath = normalizeFilePath(filePath);

  // Check file size (>1MB = skip)
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  if (contentBytes > MAX_FILE_SIZE) {
    logger.warn({ filePath, size: contentBytes }, 'File exceeds 1MB, skipping embedding');
    return {
      chunksIndexed: 0,
      embeddingsGenerated: 0,
      skippedUnchanged: 0,
      skipped: true,
      reason: 'File exceeds 1MB limit',
    };
  }

  // Remove old chunks for this file before re-indexing
  const oldChunks = getChunksForFile(groupFolder, filePath);
  const oldHashMap = new Map<number, string>();
  for (const chunk of oldChunks) {
    oldHashMap.set(chunk.chunkIndex, chunk.contentHash);
  }

  // Chunk the content
  const chunks = chunkText(content);
  if (chunks.length === 0) {
    // Empty content — remove any existing chunks
    removeChunksForFile(groupFolder, filePath);
    return { chunksIndexed: 0, embeddingsGenerated: 0, skippedUnchanged: 0 };
  }

  // Remove old chunks (will be replaced)
  removeChunksForFile(groupFolder, filePath);

  let embeddingsGenerated = 0;
  let skippedUnchanged = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkContent = chunks[i];
    const contentHash = createHash('sha256').update(chunkContent).digest('hex');
    const chunkId = `${groupFolder}::${filePath}::${i}`;

    // Check if content hash matches old chunk at same index
    const oldHash = oldHashMap.get(i);
    let embedding: Buffer | null = null;

    if (oldHash === contentHash) {
      // Content unchanged — find old embedding if it exists
      const oldChunk = oldChunks.find((c) => c.chunkIndex === i);
      if (oldChunk?.embedding) {
        embedding = oldChunk.embedding;
      }
      skippedUnchanged++;
    } else {
      // Content changed or new — generate embedding
      try {
        const embeddingArray = await generateEmbeddings(chunkContent);
        embedding = float32ArrayToBuffer(embeddingArray);
        embeddingsGenerated++;
      } catch (err) {
        logger.warn({ err, filePath, chunkIndex: i }, 'Failed to generate embedding for chunk');
        // Store with NULL embedding — will be re-embedded later
        embedding = null;
      }
    }

    const storedChunk: StoredChunk = {
      id: chunkId,
      groupFolder,
      filePath,
      chunkIndex: i,
      content: chunkContent,
      contentHash,
      embedding,
    };

    store.set(storeKey(groupFolder, filePath, i), storedChunk);

    // Write-through to persistence
    if (persistence) {
      persistence.saveChunk(storedChunk);
    }
  }

  // P0-2: Evict oldest entries if store exceeds MAX_STORE_SIZE
  if (store.size > MAX_STORE_SIZE) {
    const excess = store.size - MAX_STORE_SIZE;
    const keys = store.keys();
    for (let i = 0; i < excess; i++) {
      const key = keys.next().value;
      if (key) store.delete(key);
    }
    logger.warn({ storeSize: store.size, evicted: excess }, 'Embedding store exceeded max size, evicted oldest chunks');
  }

  return {
    chunksIndexed: chunks.length,
    embeddingsGenerated,
    skippedUnchanged,
  };
}

// ---------------------------------------------------------------------------
// 8. removeFileEmbeddings — cleanup on file delete
// ---------------------------------------------------------------------------

/**
 * Remove all chunks and embeddings for a file.
 */
export async function removeFileEmbeddings(
  groupFolder: string,
  filePath: string,
): Promise<RemoveResult> {
  assertValidGroupFolder(groupFolder);
  filePath = normalizeFilePath(filePath);

  const removed = removeChunksForFile(groupFolder, filePath);
  return { removedChunks: removed };
}

// ---------------------------------------------------------------------------
// Helpers — Buffer <-> Float32Array conversion
// ---------------------------------------------------------------------------

function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  // Copy into aligned ArrayBuffer using set() instead of byte loop
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}
