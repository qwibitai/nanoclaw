/**
 * Noise filter for memory retrieval pipeline.
 * Filters out low-quality / noisy results based on text content.
 * Enhanced with content-quality heuristics beyond the basic stub.
 */

/**
 * Filter noise from retrieval results.
 * Removes entries whose text is too short, empty, or looks like noise.
 */
export function filterNoise<T>(
  results: T[],
  getText: (item: T) => string,
): T[] {
  return results.filter((item) => {
    const text = getText(item);
    if (!text || text.trim().length < 5) return false;
    // Filter out entries that are just whitespace/punctuation
    if (/^[\s\p{P}]+$/u.test(text)) return false;
    // Filter out entries that are just repeated characters
    if (/^(.)\1{4,}$/u.test(text.trim())) return false;
    // Filter out entries that are just numbers
    if (/^\d+$/.test(text.trim())) return false;
    // Filter out entries that look like file paths only (no context)
    if (/^[\/\\][\w\/\\.]+$/.test(text.trim()) && text.trim().length < 50) return false;
    // Filter out entries that are just URLs without context
    if (/^https?:\/\/\S+$/i.test(text.trim()) && text.trim().length < 100) return false;
    return true;
  });
}

/**
 * Score content quality on a 0–1 scale.
 * Higher = better quality, more informative content.
 * Used by the retriever to boost high-quality results.
 */
export function scoreContentQuality(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  const trimmed = text.trim();
  let score = 0.5; // baseline

  // Length scoring: very short or very long texts are lower quality
  const len = trimmed.length;
  if (len >= 20 && len <= 500) score += 0.2;       // sweet spot
  else if (len >= 10 && len <= 1000) score += 0.1;  // acceptable
  else if (len < 10) score -= 0.2;                   // too short
  // very long is fine, no penalty

  // Word diversity: count unique words / total words
  const words = trimmed.toLowerCase().split(/\s+/);
  if (words.length >= 3) {
    const uniqueRatio = new Set(words).size / words.length;
    score += uniqueRatio * 0.15;
  }

  // Has meaningful structure (sentences, not just fragments)
  if (/[.!?]/.test(trimmed)) score += 0.05;

  // Penalize all-caps
  if (trimmed === trimmed.toUpperCase() && trimmed.length > 10) score -= 0.1;

  // Penalize excessive special characters
  const specialRatio = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length / len;
  if (specialRatio > 0.3) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}
