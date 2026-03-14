/**
 * Semantic memory powered by memory-lancedb-pro.
 * Hybrid retrieval: vector + BM25, cross-encoder reranking, recency boost.
 * Supports local (default) or cloud via LANCEDB_URI + LANCEDB_API_KEY.
 *
 * Embedding providers (set EMBEDDING_PROVIDER):
 *   gemini   — Google Gemini (default), model gemini-embedding-001, 3072-dim
 *   jina     — Jina AI, model jina-embeddings-v5-text-small, 1024-dim
 *   openai   — OpenAI, model text-embedding-3-small, 1536-dim
 *   ollama   — Local Ollama, model nomic-embed-text, provider-specific dim
 *   custom   — Any OpenAI-compatible endpoint (set EMBEDDING_BASE_URL)
 *
 * Rerank providers (set RERANK_PROVIDER):
 *   jina        — Jina (default), model jina-reranker-v3
 *   siliconflow — SiliconFlow, model BAAI/bge-reranker-v2-m3
 *   voyage      — Voyage AI, model rerank-2.5
 *   pinecone    — Pinecone, model bge-reranker-v2-m3
 *   vllm        — Local vLLM / Docker Model Runner
 *   none        — Disable reranking
 */

import { MemoryStore } from './memory-store.js';
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } from './memory-retriever.js';
import type { RetrievalConfig } from './memory-retriever.js';
import { Embedder } from './memory-embedder.js';

// ── Storage config ───────────────────────────────────────────────────────────

const LANCEDB_URI     = process.env.LANCEDB_URI     || '';
const LANCEDB_API_KEY = process.env.LANCEDB_API_KEY || '';
const LOCAL_DB_DIR    = process.env.MEMORY_LANCEDB_DIR || '/workspace/group/memory/lancedb';

// ── Embedding config ─────────────────────────────────────────────────────────

const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'gemini';
const EMBEDDING_API_KEY  = process.env.EMBEDDING_API_KEY || process.env.GEMINI_API_KEY || '';
const EMBEDDING_MODEL    = process.env.EMBEDDING_MODEL    || '';
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || '';
const EMBEDDING_DIM      = process.env.EMBEDDING_DIM ? parseInt(process.env.EMBEDDING_DIM, 10) : 0;

interface ProviderDefaults {
  baseURL: string;
  model: string;
  dimensions: number;
  apiKeyEnv?: string;       // fallback env var for API key
  taskQuery?: string;       // task type for query embeddings
  taskPassage?: string;     // task type for passage embeddings
  normalized?: boolean;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  gemini: {
    baseURL:    'https://generativelanguage.googleapis.com/v1beta/openai/',
    model:      'gemini-embedding-001',
    dimensions: 3072,
    apiKeyEnv:  'GEMINI_API_KEY',
  },
  jina: {
    baseURL:    'https://api.jina.ai/v1',
    model:      'jina-embeddings-v5-text-small',
    dimensions: 1024,
    apiKeyEnv:  'JINA_API_KEY',
    taskQuery:  'retrieval.query',
    taskPassage:'retrieval.passage',
    normalized: true,
  },
  openai: {
    baseURL:    'https://api.openai.com/v1',
    model:      'text-embedding-3-small',
    dimensions: 1536,
    apiKeyEnv:  'OPENAI_API_KEY',
  },
  ollama: {
    baseURL:    'http://localhost:11434/v1',
    model:      'nomic-embed-text',
    dimensions: 768,
  },
  custom: {
    baseURL:    '',
    model:      '',
    dimensions: 0,
  },
};

function resolveEmbeddingConfig() {
  const provider = EMBEDDING_PROVIDER.toLowerCase();
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;

  const apiKey = EMBEDDING_API_KEY
    || (defaults.apiKeyEnv ? (process.env[defaults.apiKeyEnv] || '') : '')
    || undefined;

  return {
    provider: 'openai-compatible' as const,
    apiKey,
    baseURL:    EMBEDDING_BASE_URL || defaults.baseURL,
    model:      EMBEDDING_MODEL    || defaults.model,
    dimensions: EMBEDDING_DIM      || defaults.dimensions || undefined,
    taskQuery:  defaults.taskQuery,
    taskPassage:defaults.taskPassage,
    normalized: defaults.normalized,
  };
}

// ── Rerank config ────────────────────────────────────────────────────────────

type RerankProvider = 'jina' | 'siliconflow' | 'voyage' | 'pinecone' | 'vllm';

const RERANK_PROVIDER = process.env.RERANK_PROVIDER || '';
const RERANK_API_KEY  = process.env.RERANK_API_KEY  || '';
const RERANK_MODEL    = process.env.RERANK_MODEL    || '';
const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT || '';

interface RerankDefaults {
  endpoint: string;
  model: string;
  apiKeyEnv?: string;
}

const RERANK_DEFAULTS: Record<string, RerankDefaults> = {
  jina: {
    endpoint:  'https://api.jina.ai/v1/rerank',
    model:     'jina-reranker-v3',
    apiKeyEnv: 'JINA_API_KEY',
  },
  siliconflow: {
    endpoint:  'https://api.siliconflow.com/v1/rerank',
    model:     'BAAI/bge-reranker-v2-m3',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
  },
  voyage: {
    endpoint:  'https://api.voyageai.com/v1/rerank',
    model:     'rerank-2.5',
    apiKeyEnv: 'VOYAGE_API_KEY',
  },
  pinecone: {
    endpoint:  'https://api.pinecone.io/rerank',
    model:     'bge-reranker-v2-m3',
    apiKeyEnv: 'PINECONE_API_KEY',
  },
  vllm: {
    endpoint:  'http://localhost:8000/v1/rerank',
    model:     'BAAI/bge-reranker-v2-m3',
  },
};

function resolveRetrievalConfig(): Partial<RetrievalConfig> {
  const provider = RERANK_PROVIDER.toLowerCase();
  if (!provider || provider === 'none') {
    // Hint: if a rerank-capable API key is present but RERANK_PROVIDER is unset
    const hintKeys: Array<[string, string]> = [
      ['JINA_API_KEY', 'jina'],
      ['VOYAGE_API_KEY', 'voyage'],
      ['PINECONE_API_KEY', 'pinecone'],
      ['SILICONFLOW_API_KEY', 'siliconflow'],
    ];
    for (const [envKey, providerName] of hintKeys) {
      if (process.env[envKey]) {
        console.log(`[memory] Hint: ${envKey} is set but RERANK_PROVIDER is not — set RERANK_PROVIDER=${providerName} to enable cross-encoder reranking`);
        break;
      }
    }
    return { rerank: 'none' };
  }

  const defaults = RERANK_DEFAULTS[provider];
  if (!defaults) {
    console.warn(`[memory] Unknown RERANK_PROVIDER "${provider}", disabling reranking`);
    return { rerank: 'none' };
  }

  const apiKey = RERANK_API_KEY
    || (defaults.apiKeyEnv ? (process.env[defaults.apiKeyEnv] || '') : '');

  if (!apiKey && provider !== 'vllm') {
    console.warn(`[memory] No API key for rerank provider "${provider}", disabling reranking`);
    return { rerank: 'none' };
  }

  return {
    rerank:         'cross-encoder',
    rerankProvider: provider as RerankProvider,
    rerankApiKey:   apiKey || undefined,
    rerankModel:    RERANK_MODEL    || defaults.model,
    rerankEndpoint: RERANK_ENDPOINT || defaults.endpoint,
  };
}

// ── Singletons ───────────────────────────────────────────────────────────────

let _store: MemoryStore | null = null;
let _embedder: Embedder | null = null;
let _retriever: MemoryRetriever | null = null;

function getStore(): MemoryStore {
  const embeddingConfig = resolveEmbeddingConfig();
  if (!_store) {
    const vectorDim = embeddingConfig.dimensions || 0;
    if (!vectorDim) {
      throw new Error(
        `Cannot determine embedding dimensions. Set EMBEDDING_DIM when using a custom provider.`,
      );
    }
    _store = new MemoryStore({
      dbPath:    LANCEDB_URI || LOCAL_DB_DIR,
      vectorDim,
      apiKey:    LANCEDB_URI ? (LANCEDB_API_KEY || undefined) : undefined,
    });
  }
  return _store;
}

function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = new Embedder(resolveEmbeddingConfig());
  }
  return _embedder;
}

function getRetriever(): MemoryRetriever {
  if (!_retriever) {
    const config: RetrievalConfig = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      ...resolveRetrievalConfig(),
    };
    _retriever = new MemoryRetriever(getStore(), getEmbedder(), config);
  }
  return _retriever;
}

// ── Public API (drop-in replacement for basic memory.ts) ─────────────────────

export async function memoryStore(
  text: string,
  category: string = 'general',
  importance: number = 0.7,
  meta: Record<string, unknown> = {},
  scope: string = 'global',
): Promise<string> {
  const store = getStore();
  const embedder = getEmbedder();
  const vector = await embedder.embed(text);

  const entry = await store.store({
    text,
    category: normalizeCategory(category),
    scope,
    importance,
    metadata: JSON.stringify(meta),
    vector,
  });

  return entry.id;
}

export async function memorySearch(
  query: string,
  limit: number = 5,
  category?: string,
  scope: string = 'global',
): Promise<Array<{
  id: string;
  text: string;
  category: string;
  importance: number;
  timestamp: number;
  metadata: string;
  _distance: number;
}>> {
  const retriever = getRetriever();

  const results = await retriever.retrieve({
    query,
    limit,
    scopeFilter: [scope],
    ...(category ? { category: normalizeCategory(category) } : {}),
    source: 'manual',
  });

  return results.map(r => ({
    id:         r.entry.id,
    text:       r.entry.text,
    category:   r.entry.category,
    importance: r.entry.importance,
    timestamp:  r.entry.timestamp,
    metadata:   r.entry.metadata ?? '{}',
    _distance:  1 - r.score,
  }));
}

export async function memoryDelete(id: string): Promise<void> {
  const store = getStore();
  const uuid = id.startsWith('mem-') ? id.slice(4) : id;
  await store.delete(uuid);
}

export async function memoryCount(): Promise<number> {
  const store = getStore();
  const stats = await store.stats();
  return stats.totalCount;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type ProCategory = 'preference' | 'fact' | 'decision' | 'entity' | 'other' | 'reflection';

function normalizeCategory(cat: string): ProCategory {
  const direct: Record<string, ProCategory> = {
    preference: 'preference',
    decision:   'decision',
    entity:     'entity',
    fact:       'fact',
    reflection: 'reflection',
    other:      'other',
  };
  // Map legacy category names to the closest pro category so
  // category-filtered searches still return results.
  const aliases: Record<string, ProCategory> = {
    event:   'fact',
    general: 'other',
  };
  const lower = cat.toLowerCase();
  return direct[lower] ?? aliases[lower] ?? 'other';
}
