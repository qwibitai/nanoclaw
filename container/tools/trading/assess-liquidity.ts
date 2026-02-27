/**
 * MCP Tool: assess-liquidity
 * Validate prediction market has sufficient volume and tight spreads for trading
 */

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI } from './api/common.js';

interface LiquidityInput {
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  min_volume?: number;
  max_spread?: number;
}

interface LiquidityOutput {
  symbol: string;
  platform: string;
  isLiquid: boolean;
  metrics: {
    volume_24h: number;
    open_interest: number;
    bid: number;
    ask: number;
    spread: number;
    spread_pct: number;
    depth_bid: number; // Volume at best bid
    depth_ask: number; // Volume at best ask
  };
  assessment: string;
  warnings: string[];
  timestamp: string;
}

/**
 * Assess market liquidity
 * Critical for prediction markets - thin markets can have wide spreads
 * and difficulty exiting positions
 */
export async function assessLiquidity(
  input: LiquidityInput,
): Promise<LiquidityOutput> {
  const {
    symbol,
    platform,
    min_volume = 50000, // $50K daily volume minimum
    max_spread = 0.02, // 2% spread maximum
  } = input;

  // Initialize API
  let api: MarketAPI;
  if (platform === 'polymarket') {
    api = new PolymarketAPI();
  } else {
    api = new KalshiAPI();
  }

  // Fetch market data
  const market = await api.getMarketData(symbol);

  // In production, fetch order book depth
  // For now, use mock data
  const bid = market.price * 0.98; // 2% below mid
  const ask = market.price * 1.02; // 2% above mid
  const spread = ask - bid;
  const spread_pct = spread / market.price;

  const depthBid = market.volume * 0.1; // Assume 10% of volume at best bid
  const depthAsk = market.volume * 0.1;

  // Assessment criteria
  const hasVolume = market.volume >= min_volume;
  const hasTightSpread = spread_pct <= max_spread;
  const hasDepth = depthBid >= 1000 && depthAsk >= 1000; // At least $1K each side

  const isLiquid = hasVolume && hasTightSpread && hasDepth;

  // Build warnings
  const warnings: string[] = [];
  if (!hasVolume) {
    warnings.push(
      `Low volume: $${market.volume.toFixed(0)} (minimum: $${min_volume})`,
    );
  }
  if (!hasTightSpread) {
    warnings.push(
      `Wide spread: ${(spread_pct * 100).toFixed(2)}% (maximum: ${(max_spread * 100).toFixed(2)}%)`,
    );
  }
  if (!hasDepth) {
    warnings.push(
      `Thin order book: $${depthBid.toFixed(0)} bid / $${depthAsk.toFixed(0)} ask (minimum: $1,000 each side)`,
    );
  }

  // Build assessment
  let assessment: string;
  if (isLiquid) {
    assessment = `✅ LIQUID - Good volume ($${market.volume.toFixed(0)}), tight spread (${(spread_pct * 100).toFixed(2)}%), sufficient depth. Safe to trade.`;
  } else if (hasVolume && hasTightSpread) {
    assessment = `⚠️ MARGINAL - Adequate volume and spread, but thin order book. Trade with caution, use limit orders.`;
  } else if (hasVolume) {
    assessment = `⚠️ MARGINAL - Good volume but wide spread (${(spread_pct * 100).toFixed(2)}%). Significant slippage risk.`;
  } else {
    assessment = `❌ ILLIQUID - Insufficient volume and/or depth. High risk of slippage and difficulty exiting. Avoid trading.`;
  }

  return {
    symbol,
    platform,
    isLiquid,
    metrics: {
      volume_24h: market.volume,
      open_interest: market.open_interest || 0,
      bid,
      ask,
      spread,
      spread_pct,
      depth_bid: depthBid,
      depth_ask: depthAsk,
    },
    assessment,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

// MCP tool definition
export const assessLiquidityTool = {
  name: 'trading__assess_liquidity',
  description:
    'Assess prediction market liquidity - volume, spread, order book depth. Validates market is tradeable before entering positions. Thin markets = slippage risk.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Market symbol to assess',
      },
      platform: {
        type: 'string',
        enum: ['polymarket', 'kalshi'],
        description: 'Which platform',
      },
      min_volume: {
        type: 'number',
        description: '24h volume minimum in USD (default: 50000)',
      },
      max_spread: {
        type: 'number',
        description: 'Maximum acceptable spread as decimal (default: 0.02 = 2%)',
      },
    },
    required: ['symbol', 'platform'],
  },
  handler: assessLiquidity,
};
