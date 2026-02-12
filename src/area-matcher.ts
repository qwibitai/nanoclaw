/**
 * area-matcher.ts — Fuzzy area matching for complaint routing.
 *
 * Matches free-text location descriptions against known areas in the DB
 * using exact match, substring/contains match, and Levenshtein distance.
 */
import type Database from 'better-sqlite3';

export interface AreaMatch {
  id: string;
  name: string;
  confidence: number; // 0.0 to 1.0
}

interface AreaRow {
  id: string;
  name: string;
  name_mr: string | null;
  name_hi: string | null;
}

const AREA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let areaCache: AreaRow[] | null = null;
let areaCacheTime = 0;

function getAreas(db: Database.Database): AreaRow[] {
  const now = Date.now();
  if (areaCache && now - areaCacheTime < AREA_CACHE_TTL_MS) {
    return areaCache;
  }
  areaCache = db
    .prepare('SELECT id, name, name_mr, name_hi FROM areas WHERE is_active = 1')
    .all() as AreaRow[];
  areaCacheTime = now;
  return areaCache;
}

/** Clear the area cache. Exported for testing. */
export function clearAreaCache(): void {
  areaCache = null;
  areaCacheTime = 0;
}

/** Compute Levenshtein edit distance between two strings. */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Match location text against known areas using multiple strategies.
 *
 * 1. Exact match on name/name_mr/name_hi → confidence 1.0
 * 2. Contains match (area name is substring of location) → confidence 0.9
 * 3. Levenshtein distance normalized → if > 0.6, include
 *
 * Returns matches sorted by confidence DESC, max 5 results.
 */
export function matchArea(
  db: Database.Database,
  locationText: string,
): AreaMatch[] {
  if (!locationText.trim()) return [];

  const areas = getAreas(db);

  const locationLower = locationText.toLowerCase();
  const seen = new Map<string, AreaMatch>();

  for (const area of areas) {
    const names = [area.name, area.name_mr, area.name_hi].filter(
      Boolean,
    ) as string[];
    let bestConfidence = 0;

    for (const name of names) {
      const nameLower = name.toLowerCase();

      // 1. Exact match
      if (nameLower === locationLower) {
        bestConfidence = Math.max(bestConfidence, 1.0);
        continue;
      }

      // 2. Contains match (area name is substring of location text)
      if (locationLower.includes(nameLower)) {
        bestConfidence = Math.max(bestConfidence, 0.9);
        continue;
      }

      // 3. Levenshtein fuzzy match
      const distance = levenshteinDistance(nameLower, locationLower);
      const maxLen = Math.max(nameLower.length, locationLower.length);
      const similarity = 1 - distance / maxLen;
      if (similarity > 0.6) {
        bestConfidence = Math.max(
          bestConfidence,
          Math.round(similarity * 100) / 100,
        );
      }
    }

    if (bestConfidence > 0) {
      const existing = seen.get(area.id);
      if (!existing || existing.confidence < bestConfidence) {
        seen.set(area.id, {
          id: area.id,
          name: area.name,
          confidence: bestConfidence,
        });
      }
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}
