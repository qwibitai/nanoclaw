/**
 * Noise filter stub for memory retrieval pipeline.
 * Filters out low-quality / noisy results based on text content.
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
    return true;
  });
}
