// ---------------------------------------------------------------------------
// Exponential Moving Average (EMA) indicator
// ---------------------------------------------------------------------------

/**
 * Compute the Exponential Moving Average for a price series.
 *
 * Seed: SMA of the first `period` prices.
 * Then:  ema = price * k + prevEma * (1 - k),  where k = 2 / (period + 1).
 *
 * @returns The final EMA value, or null if there are fewer prices than `period`.
 */
export function computeEma(
  prices: readonly number[],
  period: number,
): number | null {
  if (prices.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with the Simple Moving Average of the first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += prices[i];
  }
  ema /= period;

  // Walk the remainder of the series
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

// ---------------------------------------------------------------------------
// EMA crossover signal (EMA-12 vs EMA-26)
// ---------------------------------------------------------------------------

export interface EmaSignal {
  readonly direction: 'bullish' | 'bearish' | 'neutral';
  readonly strength: number;
}

const EMA_FAST = 12;
const EMA_SLOW = 26;
const MAX_DIFF_PCT = 0.5; // 0.5 % difference maps to strength 1.0

/**
 * Derive a directional signal from the EMA-12 / EMA-26 crossover.
 *
 * Strength is the absolute percentage difference between the two EMAs,
 * normalised so that a 0.5 % gap equals maximum strength (1.0).
 */
export function emaSignal(prices: readonly number[]): EmaSignal {
  const ema12 = computeEma(prices, EMA_FAST);
  const ema26 = computeEma(prices, EMA_SLOW);

  if (ema12 === null || ema26 === null) {
    return { direction: 'neutral', strength: 0 };
  }

  const diff = ema12 - ema26;
  const currentPrice = prices[prices.length - 1];

  // Guard against zero price (shouldn't happen with real data)
  if (currentPrice === 0) {
    return { direction: 'neutral', strength: 0 };
  }

  const pctDiff = Math.abs(diff / currentPrice) * 100;
  const strength = Math.min(pctDiff / MAX_DIFF_PCT, 1);

  if (diff > 0) return { direction: 'bullish', strength };
  if (diff < 0) return { direction: 'bearish', strength };
  return { direction: 'neutral', strength: 0 };
}
