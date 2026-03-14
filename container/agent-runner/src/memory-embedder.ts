/**
 * Embedding Abstraction Layer
 * OpenAI-compatible API for various embedding providers.
 * Supports automatic chunking for documents exceeding embedding context limits.
 *
 * Note: Some providers (e.g. Jina) support extra parameters like `task` and
 * `normalized` on the embeddings endpoint. The OpenAI SDK types do not include
 * these fields, so we pass them via a narrow `any` cast.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { smartChunk } from "./memory-chunker.js";

// ============================================================================
// Embedding Cache (LRU with TTL)
// ============================================================================

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  public hits = 0;
  public misses = 0;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private key(text: string, task?: string): string {
    const hash = createHash("sha256").update(`${task || ""}:${text}`).digest("hex").slice(0, 24);
    return hash;
  }

  get(text: string, task?: string): number[] | undefined {
    const k = this.key(text, task);
    const entry = this.cache.get(k);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(k);
      this.misses++;
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(k);
    this.cache.set(k, entry);
    this.hits++;
    return entry.vector;
  }

  set(text: string, task: string | undefined, vector: number[]): void {
    const k = this.key(text, task);
    // Evict oldest if full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(k, { vector, createdAt: Date.now() });
  }

  get size(): number { return this.cache.size; }
  get stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

// ============================================================================
// Types & Configuration
// ============================================================================

export interface EmbeddingConfig {
  provider: "openai-compatible";
  /** Single API key or array of keys for round-robin rotation with failover.
   *  Optional for local providers like Ollama that do not require authentication. */
  apiKey?: string | string[];
  model: string;
  baseURL?: string;
  dimensions?: number;

  /** Optional task type for query embeddings (e.g. "retrieval.query") */
  taskQuery?: string;
  /** Optional task type for passage/document embeddings (e.g. "retrieval.passage") */
  taskPassage?: string;
  /** Optional flag to request normalized embeddings (provider-dependent, e.g. Jina v5) */
  normalized?: boolean;
  /** Enable automatic chunking for documents exceeding context limits (default: true) */
  chunking?: boolean;
}

// Known embedding model dimensions
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "gemini-embedding-001": 3072,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "BAAI/bge-m3": 1024,
  "all-MiniLM-L6-v2": 384,
  "all-mpnet-base-v2": 512,

  // Jina v5
  "jina-embeddings-v5-text-small": 1024,
  "jina-embeddings-v5-text-nano": 768,

  // Qwen3 Embedding (Docker Model Runner)
  "ai/qwen3-embedding": 1024, // default tag (4B)
  "ai/qwen3-embedding:0.6B-F16": 1024,
  "ai/qwen3-embedding:4B": 1024,
  "ai/qwen3-embedding:4B-Q4_K_M": 1024,
  "ai/qwen3-embedding:8B-Q4_K_M": 1024,
};

// ============================================================================
// Utility Functions
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, any>;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (err.error && typeof err.error === "object") {
    if (typeof err.error.status === "number") return err.error.status;
    if (typeof err.error.statusCode === "number") return err.error.statusCode;
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, any>;
  if (typeof err.code === "string") return err.code;
  if (err.error && typeof err.error === "object" && typeof err.error.code === "string") {
    return err.error.code;
  }
  return undefined;
}

function getProviderLabel(baseURL: string | undefined, model: string): string {
  const base = baseURL || "";

  if (base) {
    if (/api\.jina\.ai/i.test(base)) return "Jina";
    if (/localhost:11434|127\.0\.0\.1:11434|\/ollama\b/i.test(base)) return "Ollama";
    if (/api\.openai\.com/i.test(base)) return "OpenAI";

    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  }

  if (/^jina-/i.test(model)) return "Jina";

  return "embedding provider";
}

function isAuthError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;

  const code = getErrorCode(error);
  if (code && /invalid.*key|auth|forbidden|unauthorized/i.test(code)) return true;

  const msg = getErrorMessage(error);
  return /\b401\b|\b403\b|invalid api key|api key expired|expired api key|forbidden|unauthorized|authentication failed|access denied/i.test(msg);
}

function isNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(code)) {
    return true;
  }

  const msg = getErrorMessage(error);
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|network error|socket hang up|connection refused|getaddrinfo/i.test(msg);
}

export function formatEmbeddingProviderError(
  error: unknown,
  opts: { baseURL?: string; model: string; mode?: "single" | "batch" },
): string {
  const raw = getErrorMessage(error).trim();
  if (
    raw.startsWith("Embedding provider authentication failed") ||
    raw.startsWith("Embedding provider unreachable") ||
    raw.startsWith("Failed to generate embedding from ") ||
    raw.startsWith("Failed to generate batch embeddings from ")
  ) {
    return raw;
  }

  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const provider = getProviderLabel(opts.baseURL, opts.model);
  const detail = raw.length > 0 ? raw : "unknown error";
  const suffix = [status, code].filter(Boolean).join(" ");
  const detailText = suffix ? `${suffix}: ${detail}` : detail;
  const genericPrefix =
    opts.mode === "batch"
      ? `Failed to generate batch embeddings from ${provider}: `
      : `Failed to generate embedding from ${provider}: `;

  if (isAuthError(error)) {
    let hint = `Check embedding.apiKey and endpoint for ${provider}.`;
    if (provider === "Jina") {
      hint +=
        " If your Jina key expired or lost access, replace the key or switch to a local OpenAI-compatible endpoint such as Ollama (for example baseURL http://127.0.0.1:11434/v1, with a matching model and embedding.dimensions).";
    } else if (provider === "Ollama") {
      hint +=
        " Ollama usually works with a dummy apiKey; verify the local server is running, the model is pulled, and embedding.dimensions matches the model output.";
    }
    return `Embedding provider authentication failed (${detailText}). ${hint}`;
  }

  if (isNetworkError(error)) {
    let hint = `Verify the endpoint is reachable`;
    if (opts.baseURL) {
      hint += ` at ${opts.baseURL}`;
    }
    hint += ` and that model \"${opts.model}\" is available.`;
    return `Embedding provider unreachable (${detailText}). ${hint}`;
  }

  return `${genericPrefix}${detailText}`;
}

export function getVectorDimensions(model: string, overrideDims?: number): number {
  if (overrideDims && overrideDims > 0) {
    return overrideDims;
  }

  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Either add it to EMBEDDING_DIMENSIONS or set embedding.dimensions in config.`
    );
  }

  return dims;
}

// ============================================================================
// Embedder Class
// ============================================================================

export class Embedder {
  /** Pool of OpenAI clients — one per API key for round-robin rotation. */
  private clients: OpenAI[];
  /** Round-robin index for client rotation. */
  private _clientIndex: number = 0;

  public readonly dimensions: number;
  private readonly _cache: EmbeddingCache;

  private readonly _model: string;
  private readonly _baseURL?: string;
  private readonly _taskQuery?: string;
  private readonly _taskPassage?: string;
  private readonly _normalized?: boolean;

  /** Optional requested dimensions to pass through to the embedding provider (OpenAI-compatible). */
  private readonly _requestDimensions?: number;
  /** Enable automatic chunking for long documents (default: true) */
  private readonly _autoChunk: boolean;

  constructor(config: EmbeddingConfig & { chunking?: boolean }) {
    // Normalize apiKey to array and resolve environment variables.
    // Fall back to a dummy key for local providers (e.g. Ollama) that don't require auth.
    const rawKey = config.apiKey ?? "no-key-required";
    const apiKeys = Array.isArray(rawKey) ? rawKey : [rawKey];
    const resolvedKeys = apiKeys.map(k => resolveEnvVars(k));

    this._model = config.model;
    this._baseURL = config.baseURL;
    this._taskQuery = config.taskQuery;
    this._taskPassage = config.taskPassage;
    this._normalized = config.normalized;
    this._requestDimensions = config.dimensions;
    // Enable auto-chunking by default for better handling of long documents
    this._autoChunk = config.chunking !== false;

    // Create a client pool — one OpenAI client per key
    this.clients = resolvedKeys.map(key => new OpenAI({
      apiKey: key,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    }));

    if (this.clients.length > 1) {
      console.log(`[memory-lancedb-pro] Initialized ${this.clients.length} API keys for round-robin rotation`);
    }

    this.dimensions = getVectorDimensions(config.model, config.dimensions);
    this._cache = new EmbeddingCache(256, 30); // 256 entries, 30 min TTL
  }

  // --------------------------------------------------------------------------
  // Multi-key rotation helpers
  // --------------------------------------------------------------------------

  /** Return the next client in round-robin order. */
  private nextClient(): OpenAI {
    const client = this.clients[this._clientIndex % this.clients.length];
    this._clientIndex = (this._clientIndex + 1) % this.clients.length;
    return client;
  }

  /** Check whether an error is a rate-limit / quota-exceeded / overload error. */
  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    const err = error as Record<string, any>;

    // HTTP status: 429 (rate limit) or 503 (service overload)
    if (err.status === 429 || err.status === 503) return true;

    // OpenAI SDK structured error code
    if (err.code === "rate_limit_exceeded" || err.code === "insufficient_quota") return true;

    // Nested error object (some providers)
    const nested = err.error;
    if (nested && typeof nested === "object") {
      if (nested.type === "rate_limit_exceeded" || nested.type === "insufficient_quota") return true;
      if (nested.code === "rate_limit_exceeded" || nested.code === "insufficient_quota") return true;
    }

    // Fallback: message text matching
    const msg = error instanceof Error ? error.message : String(error);
    return /rate.limit|quota|too many requests|insufficient.*credit|429|503.*overload/i.test(msg);
  }

  /**
   * Call embeddings.create with automatic key rotation on rate-limit errors.
   * Tries each key in the pool at most once before giving up.
   */
  private async embedWithRetry(payload: any): Promise<any> {
    const maxAttempts = this.clients.length;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = this.nextClient();
      try {
        return await client.embeddings.create(payload);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.isRateLimitError(error) && attempt < maxAttempts - 1) {
          console.log(
            `[memory-lancedb-pro] Attempt ${attempt + 1}/${maxAttempts} hit rate limit, rotating to next key...`
          );
          continue;
        }

        // Non-rate-limit error → don't retry, let caller handle (e.g. chunking)
        if (!this.isRateLimitError(error)) {
          throw error;
        }
      }
    }

    // All keys exhausted with rate-limit errors
    throw new Error(
      `All ${maxAttempts} API keys exhausted (rate limited). Last error: ${lastError?.message || "unknown"}`,
      { cause: lastError }
    );
  }

  /** Number of API keys in the rotation pool. */
  get keyCount(): number {
    return this.clients.length;
  }

  // --------------------------------------------------------------------------
  // Backward-compatible API
  // --------------------------------------------------------------------------

  /**
   * Backward-compatible embedding API.
   *
   * Historically the plugin used a single `embed()` method for both query and
   * passage embeddings. With task-aware providers we treat this as passage.
   */
  async embed(text: string): Promise<number[]> {
    return this.embedPassage(text);
  }

  /** Backward-compatible batch embedding API (treated as passage). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embedBatchPassage(texts);
  }

  // --------------------------------------------------------------------------
  // Task-aware API
  // --------------------------------------------------------------------------

  async embedQuery(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskQuery);
  }

  async embedPassage(text: string): Promise<number[]> {
    return this.embedSingle(text, this._taskPassage);
  }

  async embedBatchQuery(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskQuery);
  }

  async embedBatchPassage(texts: string[]): Promise<number[][]> {
    return this.embedMany(texts, this._taskPassage);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private validateEmbedding(embedding: number[]): void {
    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding is not an array (got ${typeof embedding})`);
    }
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }
  }

  private buildPayload(input: string | string[], task?: string): any {
    const payload: any = {
      model: this.model,
      input,
      // Force float output to avoid SDK default base64 decoding path.
      encoding_format: "float",
    };

    if (task) payload.task = task;
    if (this._normalized !== undefined) payload.normalized = this._normalized;

    // Some OpenAI-compatible providers support requesting a specific vector size.
    // We only pass it through when explicitly configured to avoid breaking providers
    // that reject unknown fields.
    if (this._requestDimensions && this._requestDimensions > 0) {
      payload.dimensions = this._requestDimensions;
    }

    return payload;
  }

  private async embedSingle(text: string, task?: string, _depth = 0): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot embed empty text");
    }

    // Check cache first
    const cached = this._cache.get(text, task);
    if (cached) return cached;

    try {
      const response = await this.embedWithRetry(this.buildPayload(text, task));
      const embedding = response.data[0]?.embedding as number[] | undefined;
      if (!embedding) {
        throw new Error("No embedding returned from provider");
      }

      this.validateEmbedding(embedding);
      this._cache.set(text, task, embedding);
      return embedding;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk && _depth === 0) {
        try {
          console.log(`Document exceeded context limit (${errorMsg}), attempting chunking...`);
          const chunkResult = smartChunk(text, this._model);
          
          if (chunkResult.chunks.length === 0) {
            throw new Error(`Failed to chunk document: ${errorMsg}`);
          }

          // Embed all chunks in parallel
          console.log(`Split document into ${chunkResult.chunkCount} chunks for embedding`);
          const chunkEmbeddings = await Promise.all(
            chunkResult.chunks.map(async (chunk, idx) => {
              try {
                const embedding = await this.embedSingle(chunk, task, _depth + 1);
                return { embedding };
              } catch (chunkError) {
                console.warn(`Failed to embed chunk ${idx}:`, chunkError);
                throw chunkError;
              }
            })
          );

          // Compute average embedding across chunks
          const avgEmbedding = chunkEmbeddings.reduce(
            (sum, { embedding }) => {
              for (let i = 0; i < embedding.length; i++) {
                sum[i] += embedding[i];
              }
              return sum;
            },
            new Array(this.dimensions).fill(0)
          );

          const rawAvg = avgEmbedding.map(v => v / chunkEmbeddings.length);
          // L2-normalize so cosine similarity remains valid after averaging
          const norm = Math.sqrt(rawAvg.reduce((s, v) => s + v * v, 0)) || 1;
          const finalEmbedding = rawAvg.map(v => v / norm);
          
          // Cache the result for the original text (using its hash)
          this._cache.set(text, task, finalEmbedding);
          console.log(`Successfully embedded long document as ${chunkEmbeddings.length} averaged chunks`);
          
          return finalEmbedding;
        } catch (chunkError) {
          // If chunking fails, throw the original error
          console.warn(`Chunking failed, using original error:`, chunkError);
          const friendly = formatEmbeddingProviderError(error, {
            baseURL: this._baseURL,
            model: this._model,
            mode: "single",
          });
          throw new Error(friendly, { cause: error });
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "single",
      });
      throw new Error(friendly, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async embedMany(texts: string[], task?: string): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track indices
    const validTexts: string[] = [];
    const validIndices: number[] = [];

    texts.forEach((text, index) => {
      if (text && text.trim().length > 0) {
        validTexts.push(text);
        validIndices.push(index);
      }
    });

    if (validTexts.length === 0) {
      // Return zero vectors of correct dimension so callers don't get shape mismatches
      return texts.map(() => new Array(this.dimensions).fill(0));
    }

    try {
      const response = await this.embedWithRetry(
        this.buildPayload(validTexts, task)
      );

      // Create result array with proper length
      const results: number[][] = new Array(texts.length);

      // Fill in embeddings for valid texts
      response.data.forEach((item: any, idx: number) => {
        const originalIndex = validIndices[idx];
        const embedding = item.embedding as number[];

        this.validateEmbedding(embedding);
        results[originalIndex] = embedding;
      });

      // Fill empty arrays for invalid texts
      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) {
          results[i] = new Array(this.dimensions).fill(0);
        }
      }

      return results;
    } catch (error) {
      // Check if this is a context length exceeded error and try chunking each text
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isContextError = /context|too long|exceed|length/i.test(errorMsg);

      if (isContextError && this._autoChunk) {
        try {
          console.log(`Batch embedding failed with context error, attempting chunking...`);
          
          const chunkResults = await Promise.all(
            validTexts.map(async (text, idx) => {
              const chunkResult = smartChunk(text, this._model);
              if (chunkResult.chunks.length === 0) {
                throw new Error("Chunker produced no chunks");
              }

              // Embed all chunks in parallel, then average.
              const embeddings = await Promise.all(
                chunkResult.chunks.map((chunk) => this.embedSingle(chunk, task))
              );

              const avgEmbedding = embeddings.reduce(
                (sum, emb) => {
                  for (let i = 0; i < emb.length; i++) {
                    sum[i] += emb[i];
                  }
                  return sum;
                },
                new Array(this.dimensions).fill(0)
              );

              const rawAvg = avgEmbedding.map((v) => v / embeddings.length);
              // L2-normalize so cosine similarity remains valid after averaging
              const norm = Math.sqrt(rawAvg.reduce((s, v) => s + v * v, 0)) || 1;
              const finalEmbedding = rawAvg.map((v) => v / norm);

              // Cache the averaged embedding for the original (long) text.
              this._cache.set(text, task, finalEmbedding);

              return { embedding: finalEmbedding, index: validIndices[idx] };
            })
          );

          console.log(`Successfully chunked and embedded ${chunkResults.length} long documents`);

          // Build results array
          const results: number[][] = new Array(texts.length);
          chunkResults.forEach(({ embedding, index }) => {
            if (embedding.length > 0) {
              this.validateEmbedding(embedding);
              results[index] = embedding;
            } else {
              results[index] = new Array(this.dimensions).fill(0);
            }
          });

          // Fill empty arrays for invalid texts
          for (let i = 0; i < texts.length; i++) {
            if (!results[i]) {
              results[i] = new Array(this.dimensions).fill(0);
            }
          }

          return results;
        } catch (chunkError) {
          const friendly = formatEmbeddingProviderError(error, {
            baseURL: this._baseURL,
            model: this._model,
            mode: "batch",
          });
          throw new Error(`Failed to embed documents after chunking attempt: ${friendly}`, {
            cause: error instanceof Error ? error : undefined,
          });
        }
      }

      const friendly = formatEmbeddingProviderError(error, {
        baseURL: this._baseURL,
        model: this._model,
        mode: "batch",
      });
      throw new Error(friendly, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  get model(): string {
    return this._model;
  }

  // Test connection and validate configuration
  async test(): Promise<{ success: boolean; error?: string; dimensions?: number }> {
    try {
      const testEmbedding = await this.embedPassage("test");
      return {
        success: true,
        dimensions: testEmbedding.length,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  get cacheStats() {
    return {
      ...this._cache.stats,
      keyCount: this.clients.length,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new Embedder(config);
}
