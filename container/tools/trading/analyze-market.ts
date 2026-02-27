/**
 * MCP Tool: analyze-market
 * Scan prediction markets for trading opportunities using RSI and momentum signals
 */

import Database from 'better-sqlite3';
import path from 'path';

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI, MarketData, Signal } from './api/common.js';
import {
  detectRSISignals,
  detectVolatilityContractionPattern,
} from './strategies/rsi-mean-reversion.js';

interface AnalyzeMarketInput {
  platform?: 'polymarket' | 'kalshi' | 'all';
  strategy?: 'rsi_mean_reversion' | 'momentum' | 'all';
  lookback_days?: number;
  min_confidence?: number;
}

interface AnalyzeMarketOutput {
  signals: Array<Signal & { platform: string }>;
  summary: string;
  timestamp: string;
}

export async function analyzeMarket(
  input: AnalyzeMarketInput,
): Promise<AnalyzeMarketOutput> {
  const {
    platform = 'all',
    strategy = 'all',
    lookback_days = 14,
    min_confidence = 0.70,
  } = input;

  // Initialize APIs
  const apis: MarketAPI[] = [];
  if (platform === 'all' || platform === 'polymarket') {
    apis.push(new PolymarketAPI());
  }
  if (platform === 'all' || platform === 'kalshi') {
    apis.push(new KalshiAPI());
  }

  // Fetch all markets from each platform
  const allMarkets: MarketData[] = [];
  for (const api of apis) {
    const markets = await api.getAllMarkets();
    allMarkets.push(...markets);
  }

  // Get historical data for each market
  const startDate = new Date(Date.now() - lookback_days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const endDate = new Date().toISOString().split('T')[0];

  const allSignals: Array<Signal & { platform: string }> = [];

  for (const market of allMarkets) {
    try {
      // Get historical data
      const api = apis.find(a => a.platform === market.platform);
      if (!api) continue;

      const historicalData = await api.getHistoricalData(
        market.symbol,
        startDate,
        endDate,
      );

      // Detect RSI signals
      if (strategy === 'all' || strategy === 'rsi_mean_reversion') {
        const rsiSignals = detectRSISignals(historicalData, min_confidence);
        allSignals.push(
          ...rsiSignals.map(s => ({ ...s, platform: market.platform })),
        );
      }

      // Detect volatility contraction patterns (momentum)
      if (strategy === 'all' || strategy === 'momentum') {
        const vcpSignal = detectVolatilityContractionPattern(historicalData);
        if (vcpSignal) {
          allSignals.push({ ...vcpSignal, platform: market.platform });
        }
      }
    } catch (err) {
      console.error(`Error analyzing ${market.symbol}:`, err);
    }
  }

  // Sort by confidence (highest first)
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
      }),
    );
  }

  db.close();

  // Generate summary
  const topSignals = allSignals.slice(0, 5);
  const summary = `Found ${allSignals.length} trading signals across ${allMarkets.length} markets.

Top ${topSignals.length} opportunities:
${topSignals
  .map(
    (s, i) =>
      `${i + 1}. ${s.symbol} (${s.platform}): ${s.action.toUpperCase()} @ ${s.entryPrice.toFixed(4)} - ${(s.confidence * 100).toFixed(1)}% confidence
   Strategy: ${s.strategy}
   ${s.reasoning}`,
  )
  .join('\n\n')}

Stored all signals in strategy_state table for review.`;

  return {
    signals: allSignals,
    summary,
    timestamp,
  };
}

// MCP tool definition
export const analyzeMarketTool = {
  name: 'trading__analyze_market',
  description:
    'Analyze prediction markets for trading opportunities using RSI and momentum signals. Scans Polymarket and Kalshi markets, calculates technical indicators, and identifies high-probability entry points. Returns ranked list of signals with confidence scores and reasoning.',
  inputSchema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['polymarket', 'kalshi', 'all'],
        description: 'Which platform(s) to scan (default: all)',
      },
      strategy: {
        type: 'string',
        enum: ['rsi_mean_reversion', 'momentum', 'all'],
        description:
          'Which strategy to use for signal detection (default: all)',
      },
      lookback_days: {
        type: 'number',
        description:
          'Number of days of historical data to analyze (default: 14)',
      },
      min_confidence: {
        type: 'number',
        description: 'Minimum confidence threshold 0-1 (default: 0.70)',
      },
    },
  },
  handler: analyzeMarket,
};
