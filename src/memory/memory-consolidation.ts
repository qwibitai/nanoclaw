import Anthropic from '@anthropic-ai/sdk';

import {
  MEMORY_CONSOLIDATION_MODEL,
  MEMORY_RETENTION_PIN_THRESHOLD,
} from '../core/config.js';
import { EmbeddingProvider } from './memory-embeddings.js';
import { MemoryProvider } from './memory-provider.js';
import { MemoryItem } from './memory-types.js';

interface ConsolidationOptions {
  groupFolder: string;
  store: MemoryProvider;
  embeddings: EmbeddingProvider;
  minItems: number;
  clusterThreshold: number;
  maxClusters: number;
}

interface EmbeddedItem {
  item: MemoryItem;
  embedding: number[];
}

interface ConsolidatedFact {
  key: string;
  value: string;
  confidence: number;
  retiredIds: string[];
  mode: 'llm' | 'heuristic';
}

export interface ConsolidationResult {
  enabled: boolean;
  consideredItems: number;
  clustersFound: number;
  clustersProcessed: number;
  mergedItems: number;
  retiredItems: number;
  mode: 'llm' | 'heuristic' | 'none';
  skippedReason?: string;
}

export async function consolidateMemoryItems(
  input: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const active = input.store.listActiveItems(input.groupFolder, 10_000);
  if (active.length < input.minItems) {
    return {
      enabled: true,
      consideredItems: active.length,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'none',
      skippedReason: `min_items_not_reached:${input.minItems}`,
    };
  }

  const embedded = await ensureEmbeddings(
    active,
    input.store,
    input.embeddings,
  );
  if (embedded.length < input.minItems) {
    return {
      enabled: true,
      consideredItems: embedded.length,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'none',
      skippedReason: 'insufficient_embedded_items',
    };
  }

  const clusters = buildClusters(embedded, input.clusterThreshold)
    .filter((cluster) => cluster.length >= 2)
    .sort((a, b) => b.length - a.length);

  const selected = clusters.slice(0, Math.max(1, input.maxClusters));
  if (selected.length === 0) {
    return {
      enabled: true,
      consideredItems: embedded.length,
      clustersFound: 0,
      clustersProcessed: 0,
      mergedItems: 0,
      retiredItems: 0,
      mode: 'none',
      skippedReason: 'no_similar_clusters',
    };
  }

  let mergedItems = 0;
  let retiredItems = 0;
  let mode: ConsolidationResult['mode'] = 'none';

  for (const cluster of selected) {
    const merged = await mergeCluster(cluster.map((entry) => entry.item));
    if (!merged) continue;

    const saved = input.store.saveItem({
      scope: 'group',
      group_folder: input.groupFolder,
      user_id: null,
      kind: 'fact',
      key: merged.key,
      value: merged.value,
      source: 'consolidation',
      confidence: clamp01(merged.confidence),
      is_pinned: merged.confidence >= MEMORY_RETENTION_PIN_THRESHOLD,
    });

    const embedding = await input.embeddings.embedOne(
      `${saved.key}: ${saved.value}`,
    );
    input.store.saveItemEmbedding(saved.id, embedding);

    for (const id of merged.retiredIds) {
      if (id === saved.id) continue;
      input.store.softDeleteItem(id);
      retiredItems += 1;
    }

    input.store.recordEvent('memory_consolidated', 'memory_item', saved.id, {
      group_folder: input.groupFolder,
      merged_key: saved.key,
      merged_confidence: saved.confidence,
      retired_ids: merged.retiredIds,
      mode: merged.mode,
    });

    mergedItems += 1;
    mode = merged.mode;
  }

  return {
    enabled: true,
    consideredItems: embedded.length,
    clustersFound: clusters.length,
    clustersProcessed: selected.length,
    mergedItems,
    retiredItems,
    mode,
  };
}

async function ensureEmbeddings(
  items: MemoryItem[],
  store: MemoryProvider,
  embeddings: EmbeddingProvider,
): Promise<EmbeddedItem[]> {
  const out: EmbeddedItem[] = [];
  const missing: MemoryItem[] = [];

  for (const item of items) {
    const parsed = parseEmbedding(item.embedding_json);
    if (parsed) {
      out.push({ item, embedding: parsed });
    } else {
      missing.push(item);
    }
  }

  if (missing.length > 0) {
    const vectors = await embeddings.embedMany(
      missing.map((item) => `${item.key}: ${item.value}`),
    );
    for (let i = 0; i < missing.length; i += 1) {
      const item = missing[i]!;
      const embedding = vectors[i];
      if (!embedding || embedding.length === 0) continue;
      store.saveItemEmbedding(item.id, embedding);
      out.push({ item, embedding });
    }
  }

  return out;
}

function buildClusters(
  entries: EmbeddedItem[],
  threshold: number,
): EmbeddedItem[][] {
  const used = new Set<string>();
  const clusters: EmbeddedItem[][] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const seed = entries[i]!;
    if (used.has(seed.item.id)) continue;

    const cluster: EmbeddedItem[] = [seed];
    used.add(seed.item.id);

    for (let j = i + 1; j < entries.length; j += 1) {
      const candidate = entries[j]!;
      if (used.has(candidate.item.id)) continue;
      const similarity = cosineSimilarity(seed.embedding, candidate.embedding);
      if (similarity < threshold) continue;
      cluster.push(candidate);
      used.add(candidate.item.id);
    }

    clusters.push(cluster);
  }

  return clusters;
}

async function mergeCluster(
  items: MemoryItem[],
): Promise<ConsolidatedFact | null> {
  if (items.length < 2) return null;

  const llmMerge = await tryMergeWithAnthropic(items);
  if (llmMerge) {
    return {
      ...llmMerge,
      mode: 'llm',
    };
  }

  const ranked = [...items].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
  const anchor = ranked[0]!;
  const mergedValue = ranked
    .map((item) => item.value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  return {
    key: `consolidated:${anchor.key.replace(/^consolidated:/, '')}`,
    value: mergedValue || anchor.value,
    confidence: Math.max(anchor.confidence, 0.8),
    retiredIds: items.map((item) => item.id),
    mode: 'heuristic',
  };
}

async function tryMergeWithAnthropic(
  items: MemoryItem[],
): Promise<Omit<ConsolidatedFact, 'mode'> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const model =
    process.env.MEMORY_CONSOLIDATION_MODEL?.trim() ||
    process.env.CLAUDE_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    MEMORY_CONSOLIDATION_MODEL?.trim();
  if (!apiKey || !model) return null;

  const prompt = [
    'Merge these memory facts into one durable canonical memory.',
    'Return strict JSON with keys: key, value, confidence, retired_ids.',
    'Facts:',
    ...items.map(
      (item, idx) =>
        `${idx + 1}. id=${item.id} key=${item.key} confidence=${item.confidence} value=${item.value}`,
    ),
  ].join('\n');

  try {
    const client = new Anthropic({
      apiKey,
      // Resolve fetch at call-time so tests can mock global fetch.
      fetch: globalThis.fetch,
    });
    const response = await client.messages
      .create({
        model,
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      })
      .asResponse();
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = json.content?.find((block) => block.type === 'text')?.text;
    if (!text) return null;

    const parsed = parseFirstJsonObject(text) as {
      key?: unknown;
      value?: unknown;
      confidence?: unknown;
      retired_ids?: unknown;
    } | null;
    if (!parsed) return null;

    const key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
    const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
    const confidence = Number(parsed.confidence);
    const allowedIds = new Set(items.map((item) => item.id));
    const retiredIds = Array.isArray(parsed.retired_ids)
      ? parsed.retired_ids
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.trim().length > 0,
          )
          .map((id) => id.trim())
          .filter((id) => allowedIds.has(id))
      : [];

    if (!key || !value) return null;
    return {
      key,
      value,
      confidence: Number.isFinite(confidence) ? clamp01(confidence) : 0.8,
      retiredIds:
        retiredIds.length > 0 ? retiredIds : items.map((item) => item.id),
    };
  } catch {
    return null;
  }
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const values = parsed.map((value) => Number(value));
    return values.every((value) => Number.isFinite(value)) ? values : null;
  } catch {
    return null;
  }
}

function parseFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA <= 0 || magB <= 0) return 0;
  return dot / Math.sqrt(magA * magB);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
