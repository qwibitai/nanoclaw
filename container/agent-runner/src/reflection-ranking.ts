/**
 * Logistic decay scoring for reflection items.
 * Newer reflections score higher; fallback factor for missing data.
 *
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Types
// ============================================================================

export interface RankingInput {
  /** Age in milliseconds */
  ageMs: number;
  /** Number of times this reflection was accessed */
  accessCount: number;
  /** Importance score 0–1 */
  importance: number;
  /** Reflection kind half-life in days */
  halfLifeDays: number;
}

export interface RankingResult {
  /** Final ranking score (0–1) */
  score: number;
  /** Decay component */
  decayFactor: number;
  /** Access boost component */
  accessBoost: number;
  /** Importance component */
  importanceFactor: number;
}

// ============================================================================
// Scoring
// ============================================================================

const FALLBACK_FACTOR = 0.5;

/**
 * Compute a ranking score for a reflection item using logistic decay.
 *
 * Score = decayFactor * importanceFactor * (1 + accessBoost)
 *
 * decayFactor uses logistic curve: 1 / (1 + exp((age - halfLife) / steepness))
 * This gives a smooth S-curve instead of sharp exponential cutoff.
 */
export function computeReflectionScore(input: RankingInput): RankingResult {
  const { ageMs, accessCount, importance, halfLifeDays } = input;

  if (halfLifeDays <= 0) {
    return { score: FALLBACK_FACTOR, decayFactor: FALLBACK_FACTOR, accessBoost: 0, importanceFactor: 1 };
  }

  const ageDays = ageMs / 86_400_000;

  // Steepness controls how sharp the transition is (higher = sharper)
  // Floor at 0.1 to avoid division by near-zero
  const steepness = Math.max(halfLifeDays * 0.3, 0.1);

  // Logistic decay: smooth S-curve centered at half-life
  const decayFactor = 1 / (1 + Math.exp((ageDays - halfLifeDays) / steepness));

  // Access boost: logarithmic, capped
  const accessBoost = Math.min(0.3, 0.1 * Math.log2(1 + accessCount));

  // Importance factor: linear scaling
  const importanceFactor = 0.5 + 0.5 * importance;

  const score = Math.max(0, Math.min(1,
    decayFactor * importanceFactor * (1 + accessBoost)
  ));

  return { score, decayFactor, accessBoost, importanceFactor };
}

/**
 * Normalize reflection scores so they sum to 1 (for ranking context injection).
 * Returns the top N items by score.
 */
export function normalizeAndRank<T extends { score: number }>(
  items: T[],
  topN: number,
): T[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, topN);

  const totalScore = top.reduce((sum, item) => sum + item.score, 0);
  if (totalScore <= 0) return top;

  return top.map(item => ({
    ...item,
    score: item.score / totalScore,
  }));
}
