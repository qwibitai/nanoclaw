/**
 * MCP Tool: analyze-market-intraday
 * Scan Bitcoin prediction markets for 5-min and 15-min trading opportunities
 */

import Database from 'better-sqlite3';
import path from 'path';

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI, MarketData, Signal } from './api/common.js';
import {
  detectIntradayRSISignals,
  detectIntradayMomentum,
  detectSupportResistanceBounce,
  calculateIntradayRisk,
} from './strategies/intraday-btc.js';

interface AnalyzeIntradayInput {
  platform?: 'polymarket' | 'kalshi' | 'all';
  timeframe?: '5min' | '15min' | 'both';
  bitcoin_only?: boolean;
  min_confidence?: number;
}

interface AnalyzeIntradayOutput {
  signals: Array<Signal & { platform: string; risk: any }>;
  summary: string;
  timestamp: string;
  next_scan_minutes: number;
}

/**
 * Fetch recent intraday candles (mock for now, will be real-time later)
 */
async function fetchIntradayCandles(
  api: MarketAPI,
  symbol: string,
  timeframe: '5min' | '15min',
  candles = 50,
): Promise<MarketData[]> {
  // For now, generate mock intraday data
  // In production, this would call WebSocket or REST API for real-time candles

  const data: MarketData[] = [];
  const now = Date.now();
  const intervalMs = timeframe === '5min' ? 5 * 60 * 1000 : 15 * 60 * 1000;

  let basePrice = 0.45 + Math.random() * 0.1; // Starting price 0.45-0.55

  for (let i = candles; i >= 0; i--) {
    const timestamp = new Date(now - i * intervalMs);

    // Simulate price movement (random walk with slight trend)
    const change = (Math.random() - 0.48) * 0.01; // Slight upward bias
    basePrice = Math.max(0.01, Math.min(0.99, basePrice + change));

    // Simulate volume spikes occasionally
    const volumeBase = 50000;
    const volumeMultiplier = Math.random() > 0.9 ? 2.5 : 1 + Math.random() * 0.5;

    data.push({
      symbol,
      platform: api.platform,
      price: basePrice,
      volume: volumeBase * volumeMultiplier,
      openInterest: 1000000 + Math.random() * 500000,
      timestamp: timestamp.toISOString(),
      metadata: {
        timeframe,
        mock: true,
        candle_index: candles - i,
      },
    });
  }

  return data;
}

export async function analyzeMarketIntraday(
  input: AnalyzeIntradayInput,
): Promise<AnalyzeIntradayOutput> {
  const {
    platform = 'all',
    timeframe = 'both',
    bitcoin_only = true,
    min_confidence = 0.65,
  } = input;

  // Initialize APIs
  const apis: MarketAPI[] = [];
  if (platform === 'all' || platform === 'polymarket') {
    apis.push(new PolymarketAPI());
  }
  if (platform === 'all' || platform === 'kalshi') {
    apis.push(new KalshiAPI());
  }

  // Bitcoin market symbols
  const btcSymbols = [
    'BTC_100K_2024',
    'BTC_75K_EOY',
    'BTC_ABOVE_60K',
    'BITCOIN-100K-2024',
    'BITCOIN-75K-DEC',
  ];

  const timeframes: Array<'5min' | '15min'> =
    timeframe === 'both' ? ['5min', '15min'] : [timeframe];

  const allSignals: Array<Signal & { platform: string; risk: any }> = [];

  for (const api of apis) {
    for (const symbol of btcSymbols) {
      for (const tf of timeframes) {
        try {
          // Fetch intraday candles
          const candles = await fetchIntradayCandles(api, symbol, tf, 50);

          // Strategy 1: RSI Mean Reversion (intraday version)
          const rsiSignals = detectIntradayRSISignals(candles, tf, min_confidence);

          for (const signal of rsiSignals) {
            const risk = calculateIntradayRisk(signal, tf);
            allSignals.push({
              ...signal,
              platform: api.platform,
              risk,
            });
          }

          // Strategy 2: Momentum Breakouts
          const momentumSignal = detectIntradayMomentum(candles, tf);
          if (momentumSignal && momentumSignal.confidence >= min_confidence) {
            const risk = calculateIntradayRisk(momentumSignal, tf);
            allSignals.push({
              ...momentumSignal,
              platform: api.platform,
              risk,
            });
          }

          // Strategy 3: Support/Resistance Bounces
          const srSignal = detectSupportResistanceBounce(candles, tf);
          if (srSignal && srSignal.confidence >= min_confidence) {
            const risk = calculateIntradayRisk(srSignal, tf);
            allSignals.push({
              ...srSignal,
              platform: api.platform,
              risk,
            });
          }
        } catch (err) {
          console.error(`Error analyzing ${symbol} ${tf}:`, err);
        }
      }
    }
  }

  // Sort by confidence
  allSignals.sort((a, b) => b.confidence - a.confidence);

  // Store signals in database
  const db = new Database(
    path.join(process.env.STORE_DIR || '/workspace/project/store', 'messages.db'),
  );

  const timestamp = new Date().toISOString();

  for (const signal of allSignals) {
    db.prepare(
      `INSERT INTO strategy_state (timestamp, strategy_id, current_bias, rsi_2day, rsi_14day, volatility, confidence, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      timestamp,
      signal.strategy,
      signal.action === 'buy' ? 'bullish' : 'bearish',
      signal.rsi2day || null,
      signal.rsi14day || null,
      signal.volatility || null,
      signal.confidence,
      JSON.stringify({
        symbol: signal.symbol,
        platform: signal.platform,
        reasoning: signal.reasoning,
        entryPrice: signal.entryPrice,
        stopLoss: signal.risk.stopLoss,
        profitTarget: signal.risk.profitTarget,
        maxHoldMinutes: signal.risk.maxHoldMinutes,
      }),
    );
  }

  db.close();

  // Determine next scan interval
  const next_scan_minutes = timeframe === '5min' || timeframes.includes('5min') ? 5 : 15;

  // Generate summary
  const topSignals = allSignals.slice(0, 3);
  const summary = `🔍 Intraday Scan Complete (${timeframes.join(', ')})

Found ${allSignals.length} signals across ${btcSymbols.length} Bitcoin markets

${topSignals.length > 0 ? `Top ${topSignals.length} Opportunities:\n` : 'No high-confidence signals found.'}
${topSignals
  .map(
    (s, i) => {
      const timeframeLabel = s.strategy.includes('5min') ? '5min' : '15min';
      return `${i + 1}. ${s.symbol} (${s.platform}) [${timeframeLabel}]
   ${s.action.toUpperCase()} @ ${s.entryPrice.toFixed(4)} - ${(s.confidence * 100).toFixed(1)}% confidence
   ${s.reasoning}
   Stop: ${s.risk.stopLoss.toFixed(4)} | Target: ${s.risk.profitTarget.toFixed(4)} | Max Hold: ${s.risk.maxHoldMinutes}min`;
    },
  )
  .join('\n\n')}

⏰ Next scan: ${next_scan_minutes} minutes
📊 Stored ${allSignals.length} signals in strategy_state table`;

  return {
    signals: allSignals,
    summary,
    timestamp,
    next_scan_minutes,
  };
}

// MCP tool definition
export const analyzeMarketIntradayTool = {
  name: 'trading__analyze_market_intraday',
  description:
    'Scan Bitcoin prediction markets for 5-minute and 15-minute intraday trading opportunities. Detects RSI mean reversion, momentum breakouts, and support/resistance bounces. Optimized for short-term scalping with tight stops and quick exits. Returns signals with risk parameters (stop loss, profit target, max hold time).',
  inputSchema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['polymarket', 'kalshi', 'all'],
        description: 'Which platform(s) to scan (default: all)',
      },
      timeframe: {
        type: 'string',
        enum: ['5min', '15min', 'both'],
        description: 'Timeframe for analysis (default: both)',
      },
      bitcoin_only: {
        type: 'boolean',
        description: 'Focus only on Bitcoin markets (default: true)',
      },
      min_confidence: {
        type: 'number',
        description: 'Minimum confidence threshold 0-1 (default: 0.65 for intraday)',
      },
    },
  },
  handler: analyzeMarketIntraday,
};
