/**
 * Scan prediction markets for trading opportunities
 *
 * MCP tool that allows agents to discover and analyze markets across
 * Polymarket and Kalshi.
 *
 * Usage by agents:
 *   /trading__scan_markets platform=polymarket category=politics min_volume=10000
 */

import { tool } from '@anthropic/agent';
import { z } from 'zod';
import { getActiveMarkets as getPolymarketMarkets } from './api/polymarket.js';
import { getActiveMarkets as getKalshiMarkets } from './api/kalshi.js';

const inputSchema = z.object({
  platform: z
    .enum(['polymarket', 'kalshi', 'all'])
    .default('all')
    .describe('Platform to scan (polymarket | kalshi | all)'),
  category: z
    .enum(['politics', 'crypto', 'sports', 'economics', 'all'])
    .default('all')
    .describe('Market category to filter'),
  min_volume: z
    .number()
    .optional()
    .default(1000)
    .describe('Minimum 24h volume in USD'),
  min_liquidity: z
    .number()
    .optional()
    .default(5000)
    .describe('Minimum liquidity (open interest) in USD'),
  max_spread: z
    .number()
    .optional()
    .default(0.05)
    .describe('Maximum bid-ask spread (default: 5% = 0.05)'),
  limit: z
    .number()
    .optional()
    .default(20)
    .describe('Maximum number of markets to return'),
});

export const scanMarkets = tool({
  name: 'trading__scan_markets',
  description: `Scan prediction markets for trading opportunities.

  Filters markets by:
  - Platform (Polymarket, Kalshi, or both)
  - Category (politics, crypto, sports, economics)
  - Minimum volume and liquidity
  - Maximum bid-ask spread

  Returns list of active markets with current prices, volume, and liquidity.

  Use this tool to:
  - Discover new trading opportunities
  - Find high-volume markets for market-making
  - Identify liquid markets with tight spreads
  - Filter by event type (politics, crypto, etc.)`,

  parameters: inputSchema,

  async execute({ platform, category, min_volume, min_liquidity, max_spread, limit }) {
    try {
      let allMarkets: any[] = [];

      // Fetch from Polymarket
      if (platform === 'polymarket' || platform === 'all') {
        try {
          const polymarketMarkets = await getPolymarketMarkets();
          allMarkets = allMarkets.concat(
            polymarketMarkets.map((m) => ({ ...m, platform: 'polymarket' }))
          );
        } catch (error) {
          console.warn('Failed to fetch Polymarket markets:', error);
        }
      }

      // Fetch from Kalshi
      if (platform === 'kalshi' || platform === 'all') {
        try {
          const kalshiMarkets = await getKalshiMarkets();
          allMarkets = allMarkets.concat(
            kalshiMarkets.map((m) => ({ ...m, platform: 'kalshi' }))
          );
        } catch (error) {
          console.warn('Failed to fetch Kalshi markets:', error);
        }
      }

      // Filter markets
      let filtered = allMarkets.filter((market) => {
        // Category filter
        if (category !== 'all') {
          const marketCategory = market.category?.toLowerCase() || '';
          if (!marketCategory.includes(category)) return false;
        }

        // Volume filter
        if (market.volume_24h !== undefined && market.volume_24h < min_volume) {
          return false;
        }

        // Liquidity filter
        if (market.liquidity !== undefined && market.liquidity < min_liquidity) {
          return false;
        }

        // Spread filter (if available)
        if (market.best_bid && market.best_ask) {
          const spread = market.best_ask - market.best_bid;
          const spreadPct = spread / ((market.best_bid + market.best_ask) / 2);
          if (spreadPct > max_spread) return false;
        }

        return true;
      });

      // Sort by volume (descending)
      filtered.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));

      // Limit results
      filtered = filtered.slice(0, limit);

      // Format output
      const results = filtered.map((market) => {
        const spread = market.best_bid && market.best_ask ? market.best_ask - market.best_bid : null;
        const spreadPct =
          spread !== null ? (spread / ((market.best_bid + market.best_ask) / 2)) * 100 : null;

        return {
          platform: market.platform,
          market_id: market.market_id || market.id,
          question: market.question || market.title,
          category: market.category,
          current_price: market.last_price || market.mid_price,
          best_bid: market.best_bid,
          best_ask: market.best_ask,
          spread_pct: spreadPct !== null ? parseFloat(spreadPct.toFixed(2)) : null,
          volume_24h: market.volume_24h,
          liquidity: market.liquidity || market.open_interest,
          close_time: market.close_time || market.expiration_time,
          url: market.url,
        };
      });

      return {
        total_markets: allMarkets.length,
        filtered_markets: results.length,
        filters_applied: {
          platform,
          category,
          min_volume,
          min_liquidity,
          max_spread: max_spread * 100 + '%',
        },
        markets: results,
      };
    } catch (error: any) {
      return {
        error: true,
        message: `Failed to scan markets: ${error.message}`,
        total_markets: 0,
        filtered_markets: 0,
        markets: [],
      };
    }
  },
});
