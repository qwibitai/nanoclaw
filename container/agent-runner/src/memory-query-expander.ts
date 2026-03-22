/**
 * Query expander stub for memory retrieval pipeline.
 * Expands queries for better BM25 recall.
 */

/**
 * Expand a query string for BM25 full-text search.
 * Currently a pass-through; can be extended with synonym expansion,
 * stemming, or LLM-based query rewriting.
 */
export function expandQuery(query: string): string {
  return query;
}
