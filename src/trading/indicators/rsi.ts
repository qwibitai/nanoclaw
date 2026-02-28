// ---------------------------------------------------------------------------
// Relative Strength Index (RSI) — Wilder's smoothing
// ---------------------------------------------------------------------------

/**
 * Compute RSI using Wilder's smoothing method.
 *
 * Requires at least `period + 1` prices (period price-changes).
 *
 * 1. Compute initial average gain / loss over the first `period` changes.
 * 2. Smooth:  avg = (prev * (period - 1) + current) / period
 * 3. RS = avgGain / avgLoss  →  RSI = 100 - 100 / (1 + RS)
 *    If avgLoss is 0, RSI = 100 (no losses).
 *
 * @returns RSI in range [0, 100], or null if insufficient data.
 */
export function computeRsi(
  prices: readonly number[],
  period: number,
): number | null {
  if (prices.length < period + 1) return null;

  // --- initial average gain / loss over first `period` changes ----------
  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gainSum += change;
    } else {
      lossSum += Math.abs(change);
    }
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // --- Wilder's smoothing for the rest of the series --------------------
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const currentGain = change > 0 ? change : 0;
    const currentLoss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
