/**
 * Intraday Bitcoin Trading Strategies
 * Optimized for 5-minute and 15-minute timeframes on Polymarket/Kalshi
 */

import { MarketData, Signal } from '../api/common.js';
import { calculateRSI, calculateVolatility } from './rsi-mean-reversion.js';

/**
 * Intraday RSI settings (different from daily)
 */
export const INTRADAY_SETTINGS = {
  // 5-minute timeframe
  '5min': {
    rsi_period: 7, // Shorter than daily (was 14)
    rsi_oversold: 25, // Less extreme than daily (was 10)
    rsi_overbought: 75,
    lookback_candles: 50, // Need 50 candles for calculations
    min_volume: 10000, // Minimum volume filter
    volatility_threshold: 0.02, // 2% intraday volatility
  },
  // 15-minute timeframe
  '15min': {
    rsi_period: 9,
    rsi_oversold: 20,
    rsi_overbought: 80,
    lookback_candles: 40,
    min_volume: 25000,
    volatility_threshold: 0.03, // 3% for 15-min
  },
};

/**
 * Detect intraday RSI mean reversion signals
 */
export function detectIntradayRSISignals(
  marketData: MarketData[],
  timeframe: '5min' | '15min',
  minConfidence = 0.65, // Lower than daily due to noise
): Signal[] {
  const signals: Signal[] = [];
  const settings = INTRADAY_SETTINGS[timeframe];

  if (marketData.length < settings.lookback_candles) {
    return signals;
  }

  // Sort by timestamp
  const sorted = [...marketData].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const prices = sorted.map(d => d.price);
  const volumes = sorted.map(d => d.volume || 0);
  const currentPrice = prices[prices.length - 1];
  const currentVolume = volumes[volumes.length - 1];

  // Volume filter - skip low volume periods
  if (currentVolume < settings.min_volume) {
    return signals;
  }

  // Calculate indicators
  const rsi = calculateRSI(prices, settings.rsi_period);
  const volatility = calculateVolatility(prices.slice(-20)); // Last 20 candles

  const currentData = sorted[sorted.length - 1];

  // Mean Reversion: Oversold conditions
  if (rsi < settings.rsi_oversold) {
    // Confidence based on how extreme + volume confirmation
    const extremeness = (settings.rsi_oversold - rsi) / settings.rsi_oversold;
    const volumeBoost = currentVolume > settings.min_volume * 1.5 ? 0.1 : 0;
    const confidence = Math.min(0.85, 0.55 + extremeness * 0.2 + volumeBoost);

    if (confidence >= minConfidence) {
      signals.push({
        symbol: currentData.symbol,
        strategy: `intraday_rsi_${timeframe}`,
        action: 'buy',
        confidence,
        entryPrice: currentPrice,
        reasoning: `Intraday oversold (${timeframe}): RSI(${settings.rsi_period}) = ${rsi.toFixed(2)} < ${settings.rsi_oversold}. Volume: ${currentVolume.toLocaleString()} (${currentVolume > settings.min_volume * 1.5 ? 'strong' : 'adequate'}). Expected bounce in next ${timeframe === '5min' ? '10-20 min' : '30-60 min'}.`,
        rsi2day: rsi,
        volatility,
      });
    }
  }

  // Mean Reversion: Overbought conditions
  if (rsi > settings.rsi_overbought) {
    const extremeness = (rsi - settings.rsi_overbought) / (100 - settings.rsi_overbought);
    const volumeBoost = currentVolume > settings.min_volume * 1.5 ? 0.1 : 0;
    const confidence = Math.min(0.85, 0.55 + extremeness * 0.2 + volumeBoost);

    if (confidence >= minConfidence) {
      signals.push({
        symbol: currentData.symbol,
        strategy: `intraday_rsi_${timeframe}`,
        action: 'sell',
        confidence,
        entryPrice: currentPrice,
        reasoning: `Intraday overbought (${timeframe}): RSI(${settings.rsi_period}) = ${rsi.toFixed(2)} > ${settings.rsi_overbought}. Volume: ${currentVolume.toLocaleString()}. Expected pullback.`,
        rsi2day: rsi,
        volatility,
      });
    }
  }

  return signals;
}

/**
 * Detect momentum breakout patterns for intraday
 */
export function detectIntradayMomentum(
  marketData: MarketData[],
  timeframe: '5min' | '15min',
): Signal | null {
  const settings = INTRADAY_SETTINGS[timeframe];

  if (marketData.length < 20) return null;

  const sorted = [...marketData].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const prices = sorted.map(d => d.price);
  const volumes = sorted.map(d => d.volume || 0);

  // Calculate recent momentum
  const recentPrices = prices.slice(-10);
  const prevPrices = prices.slice(-20, -10);

  const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
  const prevAvg = prevPrices.reduce((a, b) => a + b, 0) / prevPrices.length;

  const momentumChange = (recentAvg - prevAvg) / prevAvg;

  // Volume surge detection
  const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeSurge = recentVolume / avgVolume;

  // Breakout criteria: strong momentum + volume surge
  if (Math.abs(momentumChange) > 0.01 && volumeSurge > 1.5) {
    const action = momentumChange > 0 ? 'buy' : 'sell';
    const confidence = Math.min(0.80, 0.60 + Math.abs(momentumChange) * 10 + (volumeSurge - 1.5) * 0.1);

    return {
      symbol: sorted[sorted.length - 1].symbol,
      strategy: `momentum_breakout_${timeframe}`,
      action,
      confidence,
      entryPrice: prices[prices.length - 1],
      reasoning: `Momentum breakout detected: ${(momentumChange * 100).toFixed(2)}% price change with ${volumeSurge.toFixed(1)}x volume surge. Strong ${action === 'buy' ? 'upward' : 'downward'} momentum on ${timeframe} timeframe.`,
      volatility: calculateVolatility(prices.slice(-20)),
    };
  }

  return null;
}

/**
 * Detect support/resistance bounces (scalping strategy)
 */
export function detectSupportResistanceBounce(
  marketData: MarketData[],
  timeframe: '5min' | '15min',
): Signal | null {
  if (marketData.length < 50) return null;

  const sorted = [...marketData].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const prices = sorted.map(d => d.price);
  const currentPrice = prices[prices.length - 1];

  // Find recent highs and lows (support/resistance levels)
  const recentData = prices.slice(-30);
  const high = Math.max(...recentData);
  const low = Math.min(...recentData);
  const range = high - low;

  // Check if near support (bottom 10% of range)
  const distanceFromLow = (currentPrice - low) / range;
  if (distanceFromLow < 0.10) {
    // Near support - potential bounce
    const rsi = calculateRSI(prices, 7);

    if (rsi < 35) {
      // Oversold near support = strong buy
      return {
        symbol: sorted[sorted.length - 1].symbol,
        strategy: `support_bounce_${timeframe}`,
        action: 'buy',
        confidence: 0.75,
        entryPrice: currentPrice,
        reasoning: `Price near support level ${low.toFixed(4)} (within ${(distanceFromLow * 100).toFixed(1)}% of low). RSI ${rsi.toFixed(1)} confirms oversold. High probability bounce.`,
        rsi2day: rsi,
        volatility: calculateVolatility(prices.slice(-20)),
      };
    }
  }

  // Check if near resistance (top 10% of range)
  const distanceFromHigh = (high - currentPrice) / range;
  if (distanceFromHigh < 0.10) {
    // Near resistance - potential reversal
    const rsi = calculateRSI(prices, 7);

    if (rsi > 65) {
      // Overbought near resistance = strong sell
      return {
        symbol: sorted[sorted.length - 1].symbol,
        strategy: `resistance_rejection_${timeframe}`,
        action: 'sell',
        confidence: 0.75,
        entryPrice: currentPrice,
        reasoning: `Price near resistance level ${high.toFixed(4)} (within ${(distanceFromHigh * 100).toFixed(1)}% of high). RSI ${rsi.toFixed(1)} confirms overbought. High probability rejection.`,
        rsi2day: rsi,
        volatility: calculateVolatility(prices.slice(-20)),
      };
    }
  }

  return null;
}

/**
 * Calculate intraday risk parameters
 */
export function calculateIntradayRisk(
  signal: Signal,
  timeframe: '5min' | '15min',
): {
  stopLoss: number;
  profitTarget: number;
  maxHoldMinutes: number;
} {
  const { entryPrice, action, volatility = 0.02 } = signal;

  // Tighter stops for intraday (1-2% vs 5% daily)
  const stopDistance = volatility * 2; // 2x volatility
  const profitDistance = volatility * 3; // 3x volatility (1.5:1 risk/reward)

  const stopLoss = action === 'buy'
    ? entryPrice * (1 - stopDistance)
    : entryPrice * (1 + stopDistance);

  const profitTarget = action === 'buy'
    ? entryPrice * (1 + profitDistance)
    : entryPrice * (1 - profitDistance);

  // Max hold time (shorter than daily 5-day rule)
  const maxHoldMinutes = timeframe === '5min' ? 60 : 120; // 1-2 hours max

  return {
    stopLoss,
    profitTarget,
    maxHoldMinutes,
  };
}
