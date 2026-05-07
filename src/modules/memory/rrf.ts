export interface PerStoreResult {
  storeId: string;
  facts: Array<{
    id: string;
    content: string;
    category?: string;
    importance?: number;
    entities?: string[];
    score?: number;
    createdAt?: string;
  }>;
  failed: boolean;
}

export interface RankedFact {
  id: string;
  content: string;
  category?: string;
  importance?: number;
  entities?: string[];
  score: number;
  createdAt?: string;
}

const RRF_K = 60;
const DEFAULT_RECENCY_BOOST = 0.1;

function parseRecencyBoost(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_RECENCY_BOOST;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`MEMORY_RECALL_RRF_RECENCY_BOOST is not a finite number: "${raw}"`);
  }
  if (parsed < 0 || parsed > 1) {
    console.warn(
      `[rrf] MEMORY_RECALL_RRF_RECENCY_BOOST=${raw} out of [0,1]; clamping to ${Math.max(0, Math.min(1, parsed))}`,
    );
    return Math.max(0, Math.min(1, parsed));
  }
  return parsed;
}

const RECENCY_BOOST = parseRecencyBoost(process.env.MEMORY_RECALL_RRF_RECENCY_BOOST);

function recencyMultiplier(createdAt: string | undefined): number {
  if (!createdAt || RECENCY_BOOST === 0) return 1.0;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 1.0;
  const ageDays = (Date.now() - created) / 86_400_000;
  const boost = RECENCY_BOOST * Math.max(0, 1 - ageDays / 90);
  return 1 + boost;
}

export function mergeAndRerank(perStoreResults: PerStoreResult[], limit: number): RankedFact[] {
  if (perStoreResults.length === 0) return [];

  // Accumulate RRF scores per fact_id; track the first-seen fact metadata.
  const rrfScores = new Map<string, number>();
  const factMeta = new Map<string, Omit<RankedFact, 'score'>>();

  for (const store of perStoreResults) {
    if (store.failed) continue;
    for (let rank = 0; rank < store.facts.length; rank++) {
      const fact = store.facts[rank];
      const contribution = 1 / (RRF_K + rank + 1);
      rrfScores.set(fact.id, (rrfScores.get(fact.id) ?? 0) + contribution);
      if (!factMeta.has(fact.id)) {
        factMeta.set(fact.id, {
          id: fact.id,
          content: fact.content,
          category: fact.category,
          importance: fact.importance,
          entities: fact.entities,
          createdAt: fact.createdAt,
        });
      }
    }
  }

  const ranked: RankedFact[] = [];
  for (const [id, rrfScore] of rrfScores) {
    const meta = factMeta.get(id)!;
    ranked.push({
      ...meta,
      score: rrfScore * recencyMultiplier(meta.createdAt),
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}
