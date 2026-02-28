// ---------------------------------------------------------------------------
// Rate of Change (ROC) indicator
// ---------------------------------------------------------------------------

/**
 * Compute the Rate of Change over `periods` look-back.
 *
 *   ROC = (current - nAgo) / nAgo
 *
 * @returns ROC as a decimal ratio, or null if insufficient data or nAgo is 0.
 */
export function computeRoc(
  prices: readonly number[],
  periods: number,
): number | null {
  if (prices.length < periods + 1) return null;

  const current = prices[prices.length - 1];
  const nAgo = prices[prices.length - 1 - periods];

  if (nAgo === 0) return null;

  return (current - nAgo) / nAgo;
}
