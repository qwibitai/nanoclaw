/**
 * RSI Mean Reversion Strategy
 * Based on research: RSI < 10 entry, exit when price > yesterday's high
 * Expected: 78.5% win rate, -23.73% max drawdown
 */

import { MarketData, Signal } from '../api/common.js';

/**
 * Calculate RSI for a series of prices
 */
export function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) {
    throw new Error(`Need at least ${period + 1} data points for RSI calculation`);
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // Separate gains and losses
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));

  // Calculate average gain and loss
  const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;

  // Calculate RS and RSI
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  return rsi;
}

/**
 * Calculate volatility (standard deviation of returns)
 */
export function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

/**
 * Detect RSI mean reversion signals
 */
export function detectRSISignals(
  marketData: MarketData[],
  minConfidence = 0.7,
): Signal[] {
  const signals: Signal[] = [];

  // Need at least 15 days for 14-day RSI + 1 for current
  if (marketData.length < 15) {
    return signals;
  }

  // Sort by timestamp (oldest first)
  const sorted = [...marketData].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const prices = sorted.map(d => d.price);
  const currentPrice = prices[prices.length - 1];
  const yesterdayHigh = Math.max(...prices.slice(-2, -1));

  // Calculate RSI values
  const rsi2day = calculateRSI(prices.slice(-4), 2); // Need 3 data points for 2-day RSI
  const rsi14day = calculateRSI(prices, 14);
  const volatility = calculateVolatility(prices.slice(-14));

  const currentData = sorted[sorted.length - 1];

  // Strategy 1: RSI < 10 (Extreme Oversold)
  if (rsi2day < 10) {
    // Confidence based on how oversold (lower RSI = higher confidence)
    const confidence = Math.min(1.0, 0.7 + (10 - rsi2day) / 20);

    if (confidence >= minConfidence) {
      signals.push({
        symbol: currentData.symbol,
        strategy: 'rsi_mean_reversion',
        action: 'buy',
        confidence,
        entryPrice: currentPrice,
        reasoning: `Extreme oversold condition: RSI(2) = ${rsi2day.toFixed(2)} < 10. Historical win rate: 78.5%. Exit when price > yesterday's high (${yesterdayHigh.toFixed(4)})`,
        rsi2day,
        rsi14day,
        volatility,
      });
    }
  }

  // Strategy 2: RSI < 5 (Ultra Extreme)
  if (rsi2day < 5) {
    const confidence = 0.9; // Very high confidence for ultra-extreme conditions

    signals.push({
      symbol: currentData.symbol,
      strategy: 'rsi_ultra_extreme',
      action: 'buy',
      confidence,
      entryPrice: currentPrice,
      reasoning: `Ultra-extreme oversold: RSI(2) = ${rsi2day.toFixed(2)} < 5. Exceptionally rare condition with very high reversion probability.`,
      rsi2day,
      rsi14day,
      volatility,
    });
  }

  // Exit signal: Price crossed above yesterday's high (for smart exit strategy)
  if (currentPrice > yesterdayHigh && rsi2day > 10) {
    signals.push({
      symbol: currentData.symbol,
      strategy: 'rsi_smart_exit',
      action: 'sell',
      confidence: 0.8,
      entryPrice: currentPrice,
      reasoning: `Smart exit triggered: Price (${currentPrice.toFixed(4)}) > yesterday's high (${yesterdayHigh.toFixed(4)}). Momentum confirmed.`,
      rsi2day,
      rsi14day,
      volatility,
    });
  }

  return signals;
}

/**
 * Detect volatility contraction patterns (VCP)
 * Price consolidating with decreasing volatility often precedes breakout
 */
export function detectVolatilityContractionPattern(
  marketData: MarketData[],
): Signal | null {
  if (marketData.length < 30) return null;

  const sorted = [...marketData].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const prices = sorted.map(d => d.price);

  // Calculate volatility for recent periods
  const vol7day = calculateVolatility(prices.slice(-7));
  const vol14day = calculateVolatility(prices.slice(-14));
  const vol30day = calculateVolatility(prices.slice(-30));

  // VCP detected if volatility is contracting (recent < older periods)
  const isContracting = vol7day < vol14day && vol14day < vol30day;

  if (isContracting) {
    const currentPrice = prices[prices.length - 1];
    const confidence = 0.65 + (vol30day - vol7day) * 5; // Higher contraction = higher confidence

    return {
      symbol: sorted[sorted.length - 1].symbol,
      strategy: 'volatility_contraction',
      action: 'buy',
      confidence: Math.min(confidence, 0.9),
      entryPrice: currentPrice,
      reasoning: `Volatility Contraction Pattern detected. 7d vol: ${vol7day.toFixed(4)}, 14d vol: ${vol14day.toFixed(4)}, 30d vol: ${vol30day.toFixed(4)}. Decreasing volatility signals potential breakout.`,
      volatility: vol7day,
    };
  }

  return null;
}
