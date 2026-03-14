/**
 * Long Context Chunking System
 *
 * Goal: split documents that exceed embedding model context limits into smaller,
 * semantically coherent chunks with overlap.
 *
 * Notes:
 * - We use *character counts* as a conservative proxy for tokens.
 * - The embedder triggers this only after a provider throws a context-length error.
 */

// ============================================================================
// Types & Constants
// ============================================================================

export interface ChunkMetadata {
  startIndex: number;
  endIndex: number;
  length: number;
}

export interface ChunkResult {
  chunks: string[];
  metadatas: ChunkMetadata[];
  totalOriginalLength: number;
  chunkCount: number;
}

export interface ChunkerConfig {
  /** Maximum characters per chunk. */
  maxChunkSize: number;
  /** Overlap between chunks in characters. */
  overlapSize: number;
  /** Minimum chunk size (except the final chunk). */
  minChunkSize: number;
  /** Attempt to split on sentence boundaries for better semantic coherence. */
  semanticSplit: boolean;
  /** Max lines per chunk before we try to split earlier on a line boundary. */
  maxLinesPerChunk: number;
}

// Common embedding context limits (provider/model specific). These are typically
// token limits, but we treat them as inputs to a conservative char-based heuristic.
export const EMBEDDING_CONTEXT_LIMITS: Record<string, number> = {
  // Jina v5
  "jina-embeddings-v5-text-small": 8192,
  "jina-embeddings-v5-text-nano": 8192,

  // OpenAI
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,

  // Google
  "text-embedding-004": 8192,
  "gemini-embedding-001": 2048,

  // Local/common
  "nomic-embed-text": 8192,
  "all-MiniLM-L6-v2": 512,
  "all-mpnet-base-v2": 512,
};

export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  maxChunkSize: 4000,
  overlapSize: 200,
  minChunkSize: 200,
  semanticSplit: true,
  maxLinesPerChunk: 50,
};

// Sentence ending patterns (English + CJK-ish punctuation)
const SENTENCE_ENDING = /[.!?。！？]/;

// ============================================================================
// Helpers
// ============================================================================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function countLines(s: string): number {
  // Count \n (treat CRLF as one line break)
  return s.split(/\r\n|\n|\r/).length;
}

function findSplitEnd(text: string, start: number, maxEnd: number, minEnd: number, config: ChunkerConfig): number {
  const safeMinEnd = clamp(minEnd, start + 1, maxEnd);
  const safeMaxEnd = clamp(maxEnd, safeMinEnd, text.length);

  // Respect line limit: if we exceed maxLinesPerChunk, force earlier split at a line break.
  if (config.maxLinesPerChunk > 0) {
    const candidate = text.slice(start, safeMaxEnd);
    if (countLines(candidate) > config.maxLinesPerChunk) {
      // Find the position of the Nth line break.
      let breaks = 0;
      for (let i = start; i < safeMaxEnd; i++) {
        const ch = text[i];
        if (ch === "\n") {
          breaks++;
          if (breaks >= config.maxLinesPerChunk) {
            // Split right after this newline.
            return Math.max(i + 1, safeMinEnd);
          }
        }
      }
    }
  }

  if (config.semanticSplit) {
    // Prefer a sentence boundary near the end.
    // Scan backward from safeMaxEnd to safeMinEnd.
    for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
      if (SENTENCE_ENDING.test(text[i])) {
        // Include trailing whitespace after punctuation.
        let j = i + 1;
        while (j < safeMaxEnd && /\s/.test(text[j])) j++;
        return j;
      }
    }

    // Next best: newline boundary.
    for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
      if (text[i] === "\n") return i + 1;
    }
  }

  // Fallback: last whitespace boundary.
  for (let i = safeMaxEnd - 1; i >= safeMinEnd; i--) {
    if (/\s/.test(text[i])) return i;
  }

  return safeMaxEnd;
}

function sliceTrimWithIndices(text: string, start: number, end: number): { chunk: string; meta: ChunkMetadata } {
  const raw = text.slice(start, end);
  const leading = raw.match(/^\s*/)?.[0]?.length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0]?.length ?? 0;
  const chunk = raw.trim();

  const trimmedStart = start + leading;
  const trimmedEnd = end - trailing;

  return {
    chunk,
    meta: {
      startIndex: trimmedStart,
      endIndex: Math.max(trimmedStart, trimmedEnd),
      length: chunk.length,
    },
  };
}

// ============================================================================
// Chunking Core
// ============================================================================

export function chunkDocument(text: string, config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG): ChunkResult {
  if (!text || text.trim().length === 0) {
    return { chunks: [], metadatas: [], totalOriginalLength: 0, chunkCount: 0 };
  }

  // Validate: overlapSize must be less than maxChunkSize to guarantee forward progress
  if (config.overlapSize >= config.maxChunkSize) {
    config = { ...config, overlapSize: Math.floor(config.maxChunkSize * 0.1) };
  }

  const totalOriginalLength = text.length;
  const chunks: string[] = [];
  const metadatas: ChunkMetadata[] = [];

  let pos = 0;
  // Effective step per chunk = maxChunkSize - overlapSize, clamped to at least 1 char progress
  const effectiveStep = Math.max(1, config.maxChunkSize - config.overlapSize);
  const maxGuard = Math.max(4, Math.ceil(text.length / effectiveStep) + 5);
  let guard = 0;

  while (pos < text.length && guard < maxGuard) {
    guard++;

    const remaining = text.length - pos;
    if (remaining <= config.maxChunkSize) {
      const { chunk, meta } = sliceTrimWithIndices(text, pos, text.length);
      if (chunk.length > 0) {
        chunks.push(chunk);
        metadatas.push(meta);
      }
      break;
    }

    const maxEnd = Math.min(pos + config.maxChunkSize, text.length);
    const minEnd = Math.min(pos + config.minChunkSize, maxEnd);

    const end = findSplitEnd(text, pos, maxEnd, minEnd, config);
    const { chunk, meta } = sliceTrimWithIndices(text, pos, end);

    // If trimming made it too small, fall back to a hard split.
    if (chunk.length < config.minChunkSize) {
      const hardEnd = Math.min(pos + config.maxChunkSize, text.length);
      const hard = sliceTrimWithIndices(text, pos, hardEnd);
      if (hard.chunk.length > 0) {
        chunks.push(hard.chunk);
        metadatas.push(hard.meta);
      }
      if (hardEnd >= text.length) break;
      pos = Math.max(hardEnd - config.overlapSize, pos + 1);
      continue;
    }

    chunks.push(chunk);
    metadatas.push(meta);

    if (end >= text.length) break;

    // Move forward with overlap.
    const nextPos = Math.max(end - config.overlapSize, pos + 1);
    pos = nextPos;
  }

  return {
    chunks,
    metadatas,
    totalOriginalLength,
    chunkCount: chunks.length,
  };
}

/**
 * Smart chunker that adapts to model context limits.
 *
 * We intentionally pick conservative char limits (70% of the reported limit)
 * since token/char ratios vary.
 */
export function smartChunk(text: string, embedderModel?: string): ChunkResult {
  const limit = embedderModel ? EMBEDDING_CONTEXT_LIMITS[embedderModel] : undefined;
  const base = limit ?? 8192;

  const config: ChunkerConfig = {
    maxChunkSize: Math.max(1000, Math.floor(base * 0.7)),
    overlapSize: Math.max(0, Math.floor(base * 0.05)),
    minChunkSize: Math.max(100, Math.floor(base * 0.1)),
    semanticSplit: true,
    maxLinesPerChunk: 50,
  };

  return chunkDocument(text, config);
}

export default chunkDocument;
