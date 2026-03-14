/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with score fusion
 */

import type { MemoryStore, MemorySearchResult } from "./memory-store.js";
import type { Embedder } from "./memory-embedder.js";
import { clampInt } from "./memory-utils.js";
import { filterNoise } from "./memory-noise-filter.js";
import { expandQuery } from "./memory-query-expander.js";
import {
  AccessTracker,
  parseAccessMetadata,
  computeEffectiveHalfLife,
} from "./memory-access-tracker.js";
import { parseSmartMetadata, isMemoryActiveAt } from "./smart-metadata.js";
import type { MemoryTier } from "./smart-metadata.js";
import { DecayEngine, createDecayEngine } from "./decay-engine.js";
import { TierManager } from "./tier-manager.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score
   *  - "vllm": No auth, string[] documents, results[].relevance_score (Docker Model Runner) */
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone" | "vllm";
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /** Access reinforcement factor for time decay half-life extension.
   *  Higher = stronger reinforcement. 0 to disable. (default: 0.5) */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from access reinforcement.
   *  Prevents frequently accessed memories from becoming immortal. (default: 3) */
  maxHalfLifeMultiplier: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands. */
  source?: "manual" | "auto-recall" | "cli";
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
  /** Per-result score evolution across pipeline stages (populated when trace is enabled) */
  scoreHistory?: ScoreStep[];
}

/** Records a single score mutation for one result at one pipeline stage */
export interface ScoreStep {
  /** Pipeline stage name (e.g. "vector_search", "recency_boost") */
  stage: string;
  /** Stage category */
  stageType: "seed" | "transform" | "rerank" | "filter";
  /** Score before this stage */
  scoreBefore: number;
  /** Score after this stage */
  score: number;
  /** Delta from previous stage (positive = boosted, negative = penalized) */
  delta: number;
  /** Optional reason for the score change */
  reason?: string;
}

export interface RetrievalTraceStage {
  name: string;
  inputCount: number;
  outputCount: number;
  elapsedMs: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalTrace {
  query: string;
  limit: number;
  source: RetrievalContext["source"] | "unknown";
  mode: RetrievalConfig["mode"] | "hybrid-fallback-vector";
  scopeFilter?: string[];
  category?: string;
  totalElapsedMs: number;
  stages: RetrievalTraceStage[];
  resultCount: number;
}

export interface RetrievalExecution {
  results: RetrievalResult[];
  trace: RetrievalTrace;
}

export interface RetrievalTelemetrySnapshot {
  totalRequests: number;
  skippedRequests: number;
  /** Executed requests broken down by source (manual, auto-recall, cli, unknown) */
  executedBySource: Record<string, number>;
  /** Skipped requests broken down by source */
  skippedBySource: Record<string, number>;
  zeroResultRequests: number;
  totalResults: number;
  averageResults: number;
  averageLatencyMs: number;
  sourceBreakdown: {
    vectorOnly: number;
    bm25Only: number;
    hybrid: number;
    reranked: number;
  };
  skipReasons: Record<string, number>;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.1,
  filterNoise: true,
  rerankProvider: undefined,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
};

// ============================================================================
// Utility Functions
// ============================================================================

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone" | "vllm";

interface RerankItem {
  index: number;
  score: number;
}

/** Build provider-specific request headers and body */
function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: documents.map((text) => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "vllm":
      // Docker Model Runner / vLLM: no auth required, runs locally
      return {
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: Record<string, unknown>,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index =
        typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };

  switch (provider) {
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(data.data, ["score", "relevance_score"]) ??
        parseItems(data.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(data.data, ["relevance_score", "score"]) ??
        parseItems(data.results, ["relevance_score", "score"])
      );
    }
    case "vllm":
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow / vLLM: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private accessTracker: AccessTracker | null = null;
  private decayEngine: DecayEngine;
  private tierManager: TierManager;
  private telemetry = {
    totalRequests: 0,
    skippedRequests: 0,
    totalLatencyMs: 0,
    zeroResultRequests: 0,
    totalResults: 0,
    executedBySource: new Map<string, number>(),
    skippedBySource: new Map<string, number>(),
    sourceBreakdown: {
      vectorOnly: 0,
      bm25Only: 0,
      hybrid: 0,
      reranked: 0,
    },
    skipReasons: new Map<string, number>(),
  };

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.decayEngine = createDecayEngine();
    this.tierManager = new TierManager();
  }

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const execution = await this.retrieveWithTrace(context);
    return execution.results;
  }

  async retrieveWithTrace(
    context: RetrievalContext,
  ): Promise<RetrievalExecution> {
    const { query, limit, scopeFilter, category, source } = context;
    const safeLimit = clampInt(limit, 1, 20);
    const startedAt = Date.now();
    const trace: RetrievalTrace = {
      query,
      limit: safeLimit,
      source: source || "unknown",
      mode: this.config.mode === "vector" ? "vector" : "hybrid",
      scopeFilter,
      category,
      totalElapsedMs: 0,
      stages: [],
      resultCount: 0,
    };

    // Adaptive retrieval: skip for trivial queries (auto-recall only)
    // Manual and CLI queries always proceed — user explicitly requested retrieval
    if (source === "auto-recall") {
      const skipDecision = shouldSkipRetrieval(query);
      if (skipDecision.skip) {
        this.pushTrace(trace, "adaptive_skip", 1, 0, 0, { reason: skipDecision.reason });
        this.recordSkippedRequest(source, skipDecision.reason);
        trace.totalElapsedMs = Date.now() - startedAt;
        trace.resultCount = 0;
        return { results: [], trace };
      }
    }

    let results: RetrievalResult[];
    // Vector-only mode: force the legacy path.
    // Note: do NOT gate hybrid retrieval on store.hasFtsSupport here.
    // On cold-start (e.g. one-shot CLI), hasFtsSupport may be false until the
    // store initializes / creates the FTS index, which would incorrectly skip
    // BM25 + reranking.
    if (this.config.mode === "vector") {
      results = await this.vectorOnlyRetrieval(
        query,
        safeLimit,
        scopeFilter,
        category,
        trace,
      );
    } else {
      results = await this.hybridRetrieval(
        query,
        safeLimit,
        scopeFilter,
        category,
        trace,
      );
    }

    // Exclude inactive (superseded) memories
    const activeStartedAt = Date.now();
    const activeResults = results.filter(r => {
      const meta = parseSmartMetadata(r.entry.metadata);
      return isMemoryActiveAt(meta);
    });
    this.pushTrace(trace, "exclude_inactive", results.length, activeResults.length, Date.now() - activeStartedAt);
    results = activeResults;

    // Lifecycle boost: tier floors prevent core memories from scoring too low
    const boostStartedAt = Date.now();
    results = this.applyLifecycleBoost(results, trace, Boolean(trace));
    this.pushTrace(trace, "lifecycle_boost", activeResults.length, results.length, Date.now() - boostStartedAt);

    // Record access for reinforcement (manual recall only)
    if (this.accessTracker && source === "manual" && results.length > 0) {
      this.accessTracker.recordAccess(results.map((r) => r.entry.id));
    }

    // Tier transitions for top-3 results (async, fire-and-forget)
    if (source === "manual" && results.length > 0) {
      this.evaluateTierTransitions(results.slice(0, 3));
    }

    trace.totalElapsedMs = Date.now() - startedAt;
    trace.resultCount = results.length;
    this.recordTelemetry(results, trace);
    return { results, trace };
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    trace?: RetrievalTrace,
  ): Promise<RetrievalResult[]> {
    const embedStartedAt = Date.now();
    const queryVector = await this.embedder.embedQuery(query);
    this.pushTrace(trace, "embed_query", 1, 1, Date.now() - embedStartedAt);

    const vectorStartedAt = Date.now();
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      this.config.minScore,
      scopeFilter,
    );
    this.pushTrace(
      trace,
      "vector_search",
      0,
      results.length,
      Date.now() - vectorStartedAt,
    );

    // Filter by category if specified
    const categoryInput = results.length;
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;
    this.pushTrace(trace, "category_filter", categoryInput, filtered.length, 0, {
      applied: Boolean(category),
    });

    const mapped = filtered.map(
      (result, index) =>
        ({
          ...result,
          sources: {
            vector: { score: result.score, rank: index + 1 },
          },
          scoreHistory: trace
            ? [{ stage: "vector_search", stageType: "seed" as const, scoreBefore: 0, score: result.score, delta: 0 }]
            : undefined,
        }) as RetrievalResult,
    );

    const trackScores = Boolean(trace);
    const boosted = this.applyRecencyBoost(mapped, trace, trackScores);
    const weighted = this.applyImportanceWeight(boosted, trace, trackScores);
    const lengthNormalized = this.applyLengthNormalization(weighted, trace, trackScores);
    const timeDecayed = this.applyTimeDecay(lengthNormalized, trace, trackScores);
    const hardInput = timeDecayed.length;
    const hardFiltered = timeDecayed.filter(
      (r) => r.score >= this.config.hardMinScore,
    );
    // Mark eliminated results in scoreHistory
    if (trackScores) {
      for (const r of timeDecayed) {
        if (r.score < this.config.hardMinScore && r.scoreHistory) {
          r.scoreHistory.push({ stage: "hard_min_score:eliminated", stageType: "filter" as const, scoreBefore: r.score, score: r.score, delta: 0, reason: `below threshold ${this.config.hardMinScore}` });
        }
      }
    }
    this.pushTrace(trace, "hard_min_score", hardInput, hardFiltered.length, 0, {
      threshold: this.config.hardMinScore,
    });
    const noiseInput = hardFiltered.length;
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, (r) => r.entry.text)
      : hardFiltered;
    this.pushTrace(trace, "noise_filter", noiseInput, denoised.length, 0, {
      enabled: this.config.filterNoise,
    });

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised, 0.85, trace);

    return deduplicated.slice(0, limit);
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    trace?: RetrievalTrace,
  ): Promise<RetrievalResult[]> {
    const candidatePoolSize = Math.max(
      this.config.candidatePoolSize,
      limit * 2,
    );

    // Compute query embedding once, reuse for vector search + reranking
    const embedStartedAt = Date.now();
    const queryVector = await this.embedder.embedQuery(query);
    this.pushTrace(trace, "embed_query", 1, 1, Date.now() - embedStartedAt);

    // Run vector and BM25 searches in parallel
    const searchStartedAt = Date.now();
    const [vectorResults, bm25Results] = await Promise.all([
      this.runVectorSearch(
        queryVector,
        candidatePoolSize,
        scopeFilter,
        category,
      ),
      this.runBM25Search(expandQuery(query), candidatePoolSize, scopeFilter, category),
    ]);
    this.pushTrace(
      trace,
      "parallel_search",
      0,
      vectorResults.length + bm25Results.length,
      Date.now() - searchStartedAt,
      {
        vectorCount: vectorResults.length,
        bm25Count: bm25Results.length,
        candidatePoolSize,
      },
    );

    // Fuse results (vector score base + BM25 bonus; async batch ghost-check for BM25-only)
    const fusedResults = await this.fuseResults(
      vectorResults,
      bm25Results,
      trace,
    );

    // Apply minimum score threshold
    const minInput = fusedResults.length;
    const filtered = fusedResults.filter(
      (r) => r.score >= this.config.minScore,
    );
    this.pushTrace(trace, "min_score", minInput, filtered.length, 0, {
      threshold: this.config.minScore,
    });

    // Rerank if enabled
    const reranked =
      this.config.rerank !== "none"
        ? await this.rerankResults(
          query,
          queryVector,
          filtered.slice(0, limit * 2),
          trace,
        )
        : filtered;
    if (this.config.rerank === "none") {
      this.pushTrace(trace, "rerank", filtered.length, filtered.length, 0, {
        mode: "none",
      });
    }

    const trackScores = Boolean(trace);

    // Apply temporal re-ranking (recency boost)
    const temporalReranked = this.applyRecencyBoost(reranked, trace, trackScores);

    // Apply importance weighting
    const importanceWeighted = this.applyImportanceWeight(
      temporalReranked,
      trace,
      trackScores,
    );

    // Apply length normalization (penalize long entries dominating via keyword density)
    const lengthNormalized = this.applyLengthNormalization(
      importanceWeighted,
      trace,
      trackScores,
    );

    // Apply time decay (penalize stale entries)
    const timeDecayed = this.applyTimeDecay(lengthNormalized, trace, trackScores);

    // Hard minimum score cutoff (post all scoring stages)
    const hardInput = timeDecayed.length;
    const hardFiltered = timeDecayed.filter(
      (r) => r.score >= this.config.hardMinScore,
    );
    this.pushTrace(trace, "hard_min_score", hardInput, hardFiltered.length, 0, {
      threshold: this.config.hardMinScore,
    });

    // Filter noise
    const noiseInput = hardFiltered.length;
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, (r) => r.entry.text)
      : hardFiltered;
    this.pushTrace(trace, "noise_filter", noiseInput, denoised.length, 0, {
      enabled: this.config.filterNoise,
    });

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised, 0.85, trace);

    return deduplicated.slice(0, limit);
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      0.1,
      scopeFilter,
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter);

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>,
    trace?: RetrievalTrace,
  ): Promise<RetrievalResult[]> {
    const startedAt = Date.now();
    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

    vectorResults.forEach((result) => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach((result) => {
      bm25Map.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    // Calculate fused scores (vector base + optional BM25 bonus)
    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);

      // Use the result with more complete data (prefer vector result if both exist)
      const baseResult = vectorResult || bm25Result!;

      // Use vector similarity as the base score.
      // BM25 hit acts as a bonus (keyword match confirms relevance).
      const vectorScore = vectorResult ? vectorResult.score : 0;
      const bm25Hit = bm25Result ? 1 : 0;

      // Base = vector score; BM25 hit boosts by up to 15%
      // BM25-only results use their raw BM25 score so exact keyword matches
      // (e.g. searching "JINA_API_KEY") still surface. The previous floor of 0.5
      // was too generous and allowed ghost entries to survive hardMinScore (0.35).
      const fusedScore = vectorResult
        ? clamp01(vectorScore + bm25Hit * 0.15 * vectorScore, 0.1)
        : clamp01(bm25Result!.score, 0.1);

      const seedStage = vectorResult ? "fused" : "bm25_only";
      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult
            ? { score: vectorResult.score, rank: vectorResult.rank }
            : undefined,
          bm25: bm25Result
            ? { score: bm25Result.score, rank: bm25Result.rank }
            : undefined,
          fused: { score: fusedScore },
        },
        scoreHistory: trace
          ? [{ stage: seedStage, stageType: "seed" as const, scoreBefore: 0, score: fusedScore, delta: 0, reason: vectorResult && bm25Result ? "vector+bm25" : vectorResult ? "vector" : "bm25" }]
          : undefined,
      });
    }

    // Batch ghost-check: BM25-only results whose FTS index may be stale.
    // One query fetches all candidate IDs at once instead of N sequential hasId() calls.
    const bm25OnlyIds = fusedResults
      .filter(r => !r.sources.vector && r.sources.bm25)
      .map(r => r.entry.id);

    let liveIds: Set<string> | null = null;
    if (bm25OnlyIds.length > 0) {
      try {
        liveIds = await this.store.filterExistingIds(bm25OnlyIds);
      } catch {
        // fail-open: keep all results if the check itself errors
      }
    }

    const deghostResults = liveIds
      ? fusedResults.filter(r => r.sources.vector || liveIds!.has(r.entry.id))
      : fusedResults;

    // Sort by fused score descending
    const sorted = deghostResults.sort((a, b) => b.score - a.score);
    this.pushTrace(trace, "fuse", allIds.size, sorted.length, Date.now() - startedAt, {
      vectorCount: vectorResults.length,
      bm25Count: bm25Results.length,
    });
    return sorted;
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(
    query: string,
    queryVector: number[],
    results: RetrievalResult[],
    trace?: RetrievalTrace,
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      this.pushTrace(trace, "rerank", 0, 0, 0, { mode: this.config.rerank });
      return results;
    }

    const startedAt = Date.now();

    // Try cross-encoder rerank via configured provider API
    // vLLM (Docker Model Runner) doesn't require an API key
    const provider = this.config.rerankProvider || "jina";
    const needsApiKey = provider !== "vllm";
    const hasApiKey = !!this.config.rerankApiKey;

    if (this.config.rerank === "cross-encoder" && (!needsApiKey || hasApiKey)) {
      try {
        const model = this.config.rerankModel || "jina-reranker-v3";
        const endpoint =
          this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
        const documents = results.map((r) => r.entry.text);

        // vLLM requires a custom endpoint - fail fast if using default Jina endpoint
        if (provider === "vllm" && !this.config.rerankEndpoint) {
          throw new Error(
            "vLLM rerank provider requires rerankEndpoint to be configured. " +
            "Example: http://host.docker.internal:12434/engines/vllm/rerank"
          );
        }

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(
          provider,
          this.config.rerankApiKey || "", // vLLM doesn't use it anyway
          model,
          query,
          documents,
          results.length,
        );

        // Timeout: 5 seconds to prevent stalling retrieval pipeline
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;

          // Parse provider-specific response into unified format
          const parsed = parseRerankResponse(provider, data);

          if (!parsed) {
            console.warn(
              "Rerank API: invalid response shape, falling back to cosine",
            );
          } else {
            // Build a Set of returned indices to identify unreturned candidates
            const returnedIndices = new Set(parsed.map((r) => r.index));

            const reranked = parsed
              .filter((item) => item.index >= 0 && item.index < results.length)
              .map((item) => {
                const original = results[item.index];
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01(
                  item.score * 0.6 + original.score * 0.4,
                  original.score * 0.5,
                );
                const rerankedResult = {
                  ...original,
                  score: blendedScore,
                  sources: {
                    ...original.sources,
                    reranked: { score: item.score },
                  },
                };
                if (rerankedResult.scoreHistory) {
                  rerankedResult.scoreHistory = [...rerankedResult.scoreHistory, { stage: "rerank", stageType: "rerank" as const, scoreBefore: original.score, score: blendedScore, delta: blendedScore - original.score, reason: `cross-encoder: raw=${item.score.toFixed(4)}` }];
                }
                return rerankedResult;
              });

            // Keep unreturned candidates with their original scores (slightly penalized)
            const unreturned = results
              .filter((_, idx) => !returnedIndices.has(idx))
              .map((r) => ({ ...r, score: r.score * 0.8 }));

            const sorted = [...reranked, ...unreturned].sort(
              (a, b) => b.score - a.score,
            );
            this.pushTrace(trace, "rerank", results.length, sorted.length, Date.now() - startedAt, {
              mode: "cross-encoder",
              provider,
              returnedCount: parsed.length,
            });
            return sorted;
          }
        } else {
          const errText = await response.text().catch(() => "");
          console.warn(
            `Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.warn("Rerank API timed out (5s), falling back to cosine");
        } else {
          // Log only the error message, not the full error object (may contain API keys in headers)
          const msg = error instanceof Error ? error.message : "unknown error";
          console.warn(`Rerank API failed, falling back to cosine: ${msg}`);
        }
      }
    }

    // Fallback: lightweight cosine similarity rerank
    try {
      const reranked = results.map((result) => {
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = result.score * 0.7 + cosineScore * 0.3;

        return {
          ...result,
          score: clamp01(combinedScore, result.score),
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
      });

      const sorted = reranked.sort((a, b) => b.score - a.score);
      this.pushTrace(trace, "rerank", results.length, sorted.length, Date.now() - startedAt, {
        mode: this.config.rerank === "lightweight" ? "lightweight" : "cosine-fallback",
      });
      return sorted;
    } catch (error) {
      console.warn("Reranking failed, returning original results:", error instanceof Error ? error.message : String(error));
      this.pushTrace(trace, "rerank", results.length, results.length, Date.now() - startedAt, {
        mode: "failed",
      });
      return results;
    }
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(
    results: RetrievalResult[],
    trace?: RetrievalTrace,
    trackScores = false,
  ): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      this.pushTrace(trace, "recency_boost", results.length, results.length, 0, {
        enabled: false,
      });
      return results;
    }

    const startedAt = Date.now();
    const now = Date.now();
    const boosted = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      const prevScore = r.score;
      const newScore = clamp01(r.score + boost, r.score);
      const result = { ...r, score: newScore };
      if (trackScores && result.scoreHistory) {
        result.scoreHistory = [...result.scoreHistory, { stage: "recency_boost", stageType: "transform" as const, scoreBefore: prevScore, score: newScore, delta: newScore - prevScore }];
      }
      return result;
    });

    const sorted = boosted.sort((a, b) => b.score - a.score);
    this.pushTrace(trace, "recency_boost", results.length, sorted.length, Date.now() - startedAt, {
      halfLifeDays: recencyHalfLifeDays,
      weight: recencyWeight,
    });
    return sorted;
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
   */
  private applyImportanceWeight(
    results: RetrievalResult[],
    trace?: RetrievalTrace,
    trackScores = false,
  ): RetrievalResult[] {
    const baseWeight = 0.7;
    const startedAt = Date.now();
    const weighted = results.map((r) => {
      const importance = r.entry.importance ?? 0.7;
      const factor = baseWeight + (1 - baseWeight) * importance;
      const prevScore = r.score;
      const newScore = clamp01(r.score * factor, r.score * baseWeight);
      const result = { ...r, score: newScore };
      if (trackScores && result.scoreHistory) {
        result.scoreHistory = [...result.scoreHistory, { stage: "importance_weight", stageType: "transform" as const, scoreBefore: prevScore, score: newScore, delta: newScore - prevScore }];
      }
      return result;
    });
    const sorted = weighted.sort((a, b) => b.score - a.score);
    this.pushTrace(trace, "importance_weight", results.length, sorted.length, Date.now() - startedAt, {
      baseWeight,
    });
    return sorted;
  }

  /**
   * Length normalization: penalize long entries that dominate search results
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) are unaffected.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + 0.5 * log2(max(charLen/anchor, 1)))
   */
  private applyLengthNormalization(
    results: RetrievalResult[],
    trace?: RetrievalTrace,
    trackScores = false,
  ): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) {
      this.pushTrace(trace, "length_norm", results.length, results.length, 0, {
        enabled: false,
      });
      return results;
    }

    const startedAt = Date.now();
    const normalized = results.map((r) => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      const logRatio = Math.log2(Math.max(ratio, 1));
      const factor = 1 / (1 + 0.5 * logRatio);
      const prevScore = r.score;
      const newScore = clamp01(r.score * factor, r.score * 0.3);
      const result = { ...r, score: newScore };
      if (trackScores && result.scoreHistory) {
        result.scoreHistory = [...result.scoreHistory, { stage: "length_norm", stageType: "transform" as const, scoreBefore: prevScore, score: newScore, delta: newScore - prevScore }];
      }
      return result;
    });

    const sorted = normalized.sort((a, b) => b.score - a.score);
    this.pushTrace(trace, "length_norm", results.length, sorted.length, Date.now() - startedAt, {
      anchor,
    });
    return sorted;
  }

  /**
   * Time decay: multiplicative penalty for old entries.
   * Unlike recencyBoost (additive bonus for new entries), this actively
   * penalizes stale information so recent knowledge wins ties.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At 0 days: 1.0x (no penalty)
   * At halfLife: ~0.68x
   * At 2*halfLife: ~0.59x
   * Floor at 0.5x (never penalize more than half)
   */
  private applyTimeDecay(
    results: RetrievalResult[],
    trace?: RetrievalTrace,
    trackScores = false,
  ): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) {
      this.pushTrace(trace, "time_decay", results.length, results.length, 0, {
        enabled: false,
      });
      return results;
    }

    const startedAt = Date.now();
    const now = Date.now();
    const decayed = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;

      // Access reinforcement: frequently recalled memories decay slower
      const { accessCount, lastAccessedAt } = parseAccessMetadata(
        r.entry.metadata,
      );
      const effectiveHL = computeEffectiveHalfLife(
        halfLife,
        accessCount,
        lastAccessedAt,
        this.config.reinforcementFactor,
        this.config.maxHalfLifeMultiplier,
      );

      // floor at 0.5: even very old entries keep at least 50% of their score
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
      const prevScore = r.score;
      const newScore = clamp01(r.score * factor, r.score * 0.5);
      const result = { ...r, score: newScore };
      if (trackScores && result.scoreHistory) {
        result.scoreHistory = [...result.scoreHistory, { stage: "time_decay", stageType: "transform" as const, scoreBefore: prevScore, score: newScore, delta: newScore - prevScore }];
      }
      return result;
    });

    const sorted = decayed.sort((a, b) => b.score - a.score);
    this.pushTrace(trace, "time_decay", results.length, sorted.length, Date.now() - startedAt, {
      halfLifeDays: halfLife,
    });
    return sorted;
  }

  /**
   * MMR-inspired diversity filter: greedily select results that are both
   * relevant (high score) and diverse (low similarity to already-selected).
   *
   * Uses cosine similarity between memory vectors. If two memories have
   * cosine similarity > threshold (default 0.92), the lower-scored one
   * is demoted to the end rather than removed entirely.
   *
   * This prevents top-k from being filled with near-identical entries
   * (e.g. 3 similar "SVG style" memories) while keeping them available
   * if the pool is small.
   */
  private applyMMRDiversity(
    results: RetrievalResult[],
    similarityThreshold = 0.85,
    trace?: RetrievalTrace,
  ): RetrievalResult[] {
    if (results.length <= 1) {
      this.pushTrace(trace, "mmr_diversity", results.length, results.length, 0, {
        deferredCount: 0,
        threshold: similarityThreshold,
      });
      return results;
    }

    const startedAt = Date.now();
    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];

    for (const candidate of results) {
      // Check if this candidate is too similar to any already-selected result
      const tooSimilar = selected.some((s) => {
        // Both must have vectors to compare.
        // LanceDB returns Arrow Vector objects (not plain arrays),
        // so use .length directly and Array.from() for conversion.
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;
        const sArr = Array.from(sVec as Iterable<number>);
        const cArr = Array.from(cVec as Iterable<number>);
        const sim = cosineSimilarity(sArr, cArr);
        return sim > similarityThreshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    // Append deferred results at the end (available but deprioritized)
    const finalResults = [...selected, ...deferred];
    this.pushTrace(trace, "mmr_diversity", results.length, finalResults.length, Date.now() - startedAt, {
      deferredCount: deferred.length,
      threshold: similarityThreshold,
    });
    return finalResults;
  }

  /**
   * Lifecycle boost: apply tier-based floor scores so core memories
   * never score below the decay floor, even after all scoring stages.
   */
  private applyLifecycleBoost(
    results: RetrievalResult[],
    trace?: RetrievalTrace,
    trackScores = false,
  ): RetrievalResult[] {
    const TIER_FLOOR: Record<MemoryTier, number> = {
      core: 0.6,
      working: 0.4,
      peripheral: 0.2,
    };

    return results.map(r => {
      const meta = parseSmartMetadata(r.entry.metadata);
      const tier = meta.tier || 'working';
      const floor = TIER_FLOOR[tier] ?? 0.2;
      if (r.score >= floor) return r;

      const prevScore = r.score;
      const newScore = floor;
      const result = { ...r, score: newScore };
      if (trackScores && result.scoreHistory) {
        result.scoreHistory = [...result.scoreHistory, {
          stage: "lifecycle_boost",
          stageType: "transform" as const,
          scoreBefore: prevScore,
          score: newScore,
          delta: newScore - prevScore,
          reason: `tier=${tier} floor=${floor}`,
        }];
      }
      return result;
    }).sort((a, b) => b.score - a.score);
  }

  /**
   * Evaluate tier transitions for accessed results (fire-and-forget).
   * Promotes/demotes memories based on access patterns.
   */
  private evaluateTierTransitions(results: RetrievalResult[]): void {
    const now = Date.now();
    for (const r of results) {
      const meta = parseSmartMetadata(r.entry.metadata);
      const transition = this.tierManager.evaluate({
        id: r.entry.id,
        currentTier: meta.tier || 'working',
        accessCount: meta.access_count || 0,
        compositeScore: r.score,
        importance: r.entry.importance,
        ageMs: now - (r.entry.timestamp || now),
      });

      if (transition) {
        // Apply tier change via metadata patch (fire-and-forget)
        this.store.patchMetadata(r.entry.id, { tier: transition.to }).catch(err => {
          console.warn(`[retriever] Tier transition failed for ${r.entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  recordSkippedRequest(
    source: RetrievalContext["source"] | "unknown",
    reason: string,
  ): void {
    this.telemetry.skippedRequests += 1;
    this.bumpCounter(this.telemetry.skippedBySource, source || "unknown");
    this.bumpCounter(this.telemetry.skipReasons, reason || "unknown");
  }

  getTelemetry(): RetrievalTelemetrySnapshot {
    const totalRequests = this.telemetry.totalRequests;
    return {
      totalRequests,
      skippedRequests: this.telemetry.skippedRequests,
      executedBySource: Object.fromEntries(this.telemetry.executedBySource),
      skippedBySource: Object.fromEntries(this.telemetry.skippedBySource),
      zeroResultRequests: this.telemetry.zeroResultRequests,
      totalResults: this.telemetry.totalResults,
      averageResults:
        totalRequests > 0
          ? Number((this.telemetry.totalResults / totalRequests).toFixed(2))
          : 0,
      averageLatencyMs:
        totalRequests > 0
          ? Number((this.telemetry.totalLatencyMs / totalRequests).toFixed(2))
          : 0,
      sourceBreakdown: { ...this.telemetry.sourceBreakdown },
      skipReasons: Object.fromEntries(this.telemetry.skipReasons),
    };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    hasFtsIndex: boolean;
    canUseFts: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        hasFtsIndex: this.store.hasFtsIndex,
        canUseFts: this.store.canUseFts,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        hasFtsIndex: this.store.hasFtsIndex,
        canUseFts: this.store.canUseFts,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private pushTrace(
    trace: RetrievalTrace | undefined,
    name: string,
    inputCount: number,
    outputCount: number,
    elapsedMs: number,
    metadata?: Record<string, unknown>,
  ): void {
    if (!trace) return;
    trace.stages.push({
      name,
      inputCount,
      outputCount,
      elapsedMs,
      metadata,
    });
  }

  private bumpCounter(counter: Map<string, number>, key: string): void {
    counter.set(key, (counter.get(key) || 0) + 1);
  }

  private recordTelemetry(
    results: RetrievalResult[],
    trace: RetrievalTrace,
  ): void {
    this.telemetry.totalRequests += 1;
    this.telemetry.totalLatencyMs += trace.totalElapsedMs;
    this.telemetry.totalResults += results.length;
    this.bumpCounter(this.telemetry.executedBySource, trace.source || "unknown");
    if (results.length === 0) this.telemetry.zeroResultRequests += 1;

    for (const result of results) {
      const hasVector = Boolean(result.sources.vector);
      const hasBm25 = Boolean(result.sources.bm25);
      const hasRerank = Boolean(result.sources.reranked);
      if (hasRerank) {
        this.telemetry.sourceBreakdown.reranked += 1;
      } else if (hasVector && hasBm25) {
        this.telemetry.sourceBreakdown.hybrid += 1;
      } else if (hasVector) {
        this.telemetry.sourceBreakdown.vectorOnly += 1;
      } else if (hasBm25) {
        this.telemetry.sourceBreakdown.bm25Only += 1;
      }
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig);
}
