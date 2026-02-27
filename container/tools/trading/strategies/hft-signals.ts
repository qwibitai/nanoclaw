/**
 * HFT signal detection from orderbook microstructure
 *
 * Detects short-term trading opportunities from:
 * - Orderbook imbalances
 * - Quote stuffing / rapid updates
 * - Price momentum
 * - Spread compression
 */

export interface OrderbookSnapshot {
  timestamp: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
}

export interface HFTSignal {
  timestamp: string;
  signal: 'BUY' | 'SELL' | 'NONE';
  confidence: number; // 0-1
  reasons: string[];
  metrics: {
    imbalance: number; // -1 to 1
    momentum: number; // Price momentum score
    spreadCompression: number; // Relative to average
    updateFrequency: number; // Updates per minute
  };
}

/**
 * Calculate orderbook imbalance
 *
 * Imbalance = (BidDepth - AskDepth) / (BidDepth + AskDepth)
 * Range: -1 (ask-heavy) to +1 (bid-heavy)
 *
 * Strong bid imbalance suggests buying pressure → price likely to rise
 * Strong ask imbalance suggests selling pressure → price likely to fall
 */
export function calculateOrderbookImbalance(
  book: OrderbookSnapshot,
  levels: number = 5,
): number {
  const bidDepth = book.bids
    .slice(0, levels)
    .reduce((sum, level) => sum + level.size, 0);

  const askDepth = book.asks
    .slice(0, levels)
    .reduce((sum, level) => sum + level.size, 0);

  if (bidDepth + askDepth === 0) return 0;

  return (bidDepth - askDepth) / (bidDepth + askDepth);
}

/**
 * Calculate price momentum from recent updates
 *
 * Positive momentum = recent prices trending up
 * Negative momentum = recent prices trending down
 */
export function calculatePriceMomentum(
  recentPrices: Array<{ timestamp: string; price: number }>,
  lookbackPeriods: number = 10,
): number {
  if (recentPrices.length < 2) return 0;

  const prices = recentPrices.slice(-lookbackPeriods);

  // Simple linear regression slope
  const n = prices.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = prices[i].price;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Normalize slope by average price
  const avgPrice = sumY / n;
  const normalizedSlope = slope / avgPrice;

  return normalizedSlope;
}

/**
 * Detect quote stuffing (rapid orderbook updates)
 *
 * Quote stuffing = abnormally high update frequency
 * Can indicate HFT activity or market manipulation
 */
export function detectQuoteStuffing(
  updateTimestamps: string[],
  windowMinutes: number = 1,
  threshold: number = 100, // Updates per minute
): {
  isStuffing: boolean;
  updateFrequency: number;
  baseline: number;
} {
  if (updateTimestamps.length < 2) {
    return { isStuffing: false, updateFrequency: 0, baseline: threshold };
  }

  // Calculate updates in recent window
  const now = new Date(updateTimestamps[updateTimestamps.length - 1]);
  const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

  const recentUpdates = updateTimestamps.filter(
    ts => new Date(ts) >= windowStart,
  );

  const updateFrequency = recentUpdates.length / windowMinutes;
  const isStuffing = updateFrequency > threshold;

  return {
    isStuffing,
    updateFrequency,
    baseline: threshold,
  };
}

/**
 * Calculate spread compression
 *
 * Spread compression = current spread relative to average
 * Tight spread may indicate:
 * - High liquidity
 * - Impending price move (market makers tightening before news)
 * - Good execution opportunity
 */
export function calculateSpreadCompression(
  currentSpread: number,
  avgSpread: number,
): number {
  if (avgSpread === 0) return 0;
  return (avgSpread - currentSpread) / avgSpread;
}

/**
 * Detect HFT trading signals from orderbook microstructure
 *
 * Combines multiple signals:
 * 1. Orderbook imbalance (most important)
 * 2. Price momentum
 * 3. Spread compression
 * 4. Update frequency
 */
export function detectHFTSignal(
  currentBook: OrderbookSnapshot,
  recentBooks: OrderbookSnapshot[],
  updateTimestamps: string[],
  params: {
    imbalanceThreshold: number; // Minimum imbalance to trigger (default: 0.3)
    momentumThreshold: number; // Minimum momentum (default: 0.001)
    spreadCompressionMin: number; // Minimum spread compression (default: 0.2)
    minConfidence: number; // Minimum confidence to signal (default: 0.6)
  } = {
    imbalanceThreshold: 0.3,
    momentumThreshold: 0.001,
    spreadCompressionMin: 0.2,
    minConfidence: 0.6,
  },
): HFTSignal {
  const reasons: string[] = [];
  let confidence = 0;
  let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';

  // 1. Calculate imbalance
  const imbalance = calculateOrderbookImbalance(currentBook, 5);

  // 2. Calculate momentum
  const recentPrices = recentBooks.map(b => ({
    timestamp: b.timestamp,
    price: b.midPrice,
  }));
  const momentum = calculatePriceMomentum(recentPrices, 10);

  // 3. Calculate spread compression
  const avgSpread = recentBooks.reduce((sum, b) => sum + b.spread, 0) / recentBooks.length;
  const spreadCompression = calculateSpreadCompression(currentBook.spread, avgSpread);

  // 4. Detect quote stuffing
  const stuffing = detectQuoteStuffing(updateTimestamps, 1, 100);

  // Scoring logic
  let score = 0;

  // Imbalance signal (weight: 40%)
  if (Math.abs(imbalance) > params.imbalanceThreshold) {
    score += Math.abs(imbalance) * 0.4;
    reasons.push(
      `Strong ${imbalance > 0 ? 'bid' : 'ask'} imbalance: ${(imbalance * 100).toFixed(1)}%`,
    );
  }

  // Momentum signal (weight: 30%)
  if (Math.abs(momentum) > params.momentumThreshold) {
    score += Math.abs(momentum) * 100 * 0.3; // Scale momentum
    reasons.push(
      `Price momentum ${momentum > 0 ? 'up' : 'down'}: ${(momentum * 10000).toFixed(1)} bps/period`,
    );
  }

  // Spread compression (weight: 20%)
  if (spreadCompression > params.spreadCompressionMin) {
    score += spreadCompression * 0.2;
    reasons.push(`Tight spread: ${(spreadCompression * 100).toFixed(1)}% below average`);
  }

  // Update frequency (weight: 10%)
  if (stuffing.isStuffing) {
    score += 0.1;
    reasons.push(`High update frequency: ${stuffing.updateFrequency.toFixed(0)}/min`);
  }

  confidence = Math.min(1, score);

  // Determine signal direction
  if (confidence >= params.minConfidence) {
    // Use imbalance and momentum to determine direction
    const directionScore = imbalance * 0.6 + momentum * 1000 * 0.4;

    if (directionScore > 0.1) {
      signal = 'BUY';
      reasons.unshift('✅ BUY signal');
    } else if (directionScore < -0.1) {
      signal = 'SELL';
      reasons.unshift('✅ SELL signal');
    }
  }

  if (signal === 'NONE') {
    reasons = ['No strong signal detected'];
  }

  return {
    timestamp: currentBook.timestamp,
    signal,
    confidence,
    reasons,
    metrics: {
      imbalance,
      momentum,
      spreadCompression,
      updateFrequency: stuffing.updateFrequency,
    },
  };
}

/**
 * Batch process signals over time
 *
 * Returns array of signals for each snapshot
 */
export function detectHFTSignalsBatch(
  orderbooks: OrderbookSnapshot[],
  updateTimestamps: string[],
  lookbackPeriods: number = 20,
): HFTSignal[] {
  const signals: HFTSignal[] = [];

  for (let i = lookbackPeriods; i < orderbooks.length; i++) {
    const currentBook = orderbooks[i];
    const recentBooks = orderbooks.slice(i - lookbackPeriods, i);

    const signal = detectHFTSignal(
      currentBook,
      recentBooks,
      updateTimestamps.slice(Math.max(0, i - 100), i + 1),
    );

    signals.push(signal);
  }

  return signals;
}
