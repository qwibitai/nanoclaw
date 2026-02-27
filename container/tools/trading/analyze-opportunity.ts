/**
 * Analyze a specific prediction market opportunity
 *
 * Performs deep analysis on a single market including:
 * - Probability estimation
 * - Edge calculation
 * - Position sizing (Kelly Criterion)
 * - Historical price action
 * - Liquidity analysis
 * - Recommended action
 *
 * Usage by agents:
 *   /trading__analyze_opportunity market_id=0x123... platform=polymarket confidence=0.75
 */

import { tool } from '@anthropic/agent';
import { z } from 'zod';
import { getMarketData as getPolymarketData } from './api/polymarket.js';
import { getMarketData as getKalshiData } from './api/kalshi.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const inputSchema = z.object({
  market_id: z.string().describe('Market ID or ticker symbol'),
  platform: z.enum(['polymarket', 'kalshi']).describe('Platform where market is hosted'),
  estimated_probability: z
    .number()
    .min(0.01)
    .max(0.99)
    .optional()
    .describe('Your estimated true probability (0.01 to 0.99). If not provided, tool will estimate.'),
  confidence: z
    .number()
    .min(0.0)
    .max(1.0)
    .optional()
    .default(0.7)
    .describe('Confidence in probability estimate (0.0 to 1.0)'),
  kelly_fraction: z
    .number()
    .optional()
    .default(0.5)
    .describe('Fraction of Kelly to use for sizing (default: 0.5 = half Kelly)'),
  capital: z
    .number()
    .optional()
    .default(10000)
    .describe('Total trading capital in USD'),
});

export const analyzeOpportunity = tool({
  name: 'trading__analyze_opportunity',
  description: `Analyze a specific prediction market for trading opportunity.

  Performs comprehensive analysis:
  1. Fetches current market data (price, spread, volume, liquidity)
  2. Calculates edge (estimated_probability - market_probability)
  3. Determines recommended action (BUY, SELL, or NONE)
  4. Calculates position size using Kelly Criterion
  5. Assesses liquidity and execution feasibility
  6. Provides risk assessment

  Use this tool after scanning markets to get detailed analysis on specific opportunities.

  Example workflow:
  1. scan_markets to find candidates
  2. analyze_opportunity for each candidate
  3. execute_trade on best opportunities`,

  parameters: inputSchema,

  async execute({
    market_id,
    platform,
    estimated_probability,
    confidence,
    kelly_fraction,
    capital,
  }) {
    try {
      // Fetch market data
      let marketData: any;
      if (platform === 'polymarket') {
        marketData = await getPolymarketData(market_id);
      } else {
        marketData = await getKalshiData(market_id);
      }

      if (!marketData) {
        return {
          error: true,
          message: `Market ${market_id} not found on ${platform}`,
        };
      }

      const marketProb = marketData.last_price || marketData.mid_price || 0.5;
      const bestBid = marketData.best_bid || marketProb * 0.98;
      const bestAsk = marketData.best_ask || marketProb * 1.02;

      // If no probability estimate provided, use simple estimation
      let estimatedProb = estimated_probability;
      if (!estimatedProb) {
        // Simple heuristic: assume current price is roughly correct but with noise
        // This is placeholder - real estimation would use domain-specific models
        estimatedProb = marketProb;
        confidence = 0.5; // Low confidence in placeholder estimate
      }

      // Calculate edge
      const edge = estimatedProb - marketProb;
      const absEdge = Math.abs(edge);

      // Determine action
      let action: 'BUY' | 'SELL' | 'NONE' = 'NONE';
      if (absEdge >= 0.10 && confidence >= 0.65) {
        action = edge > 0 ? 'BUY' : 'SELL';
      }

      // Kelly Criterion position sizing
      // f* = (p * b - q) / b
      // where p = probability of winning, q = 1-p, b = odds
      let positionSize = 0;
      let kellySize = 0;

      if (action !== 'NONE') {
        const entryPrice = action === 'BUY' ? bestAsk : bestBid;
        const probWin = action === 'BUY' ? estimatedProb : 1 - estimatedProb;
        const probLoss = 1 - probWin;

        // Odds calculation
        const b = action === 'BUY' ? (1 - entryPrice) / entryPrice : entryPrice / (1 - entryPrice);

        // Kelly formula
        kellySize = (probWin * b - probLoss) / b;
        kellySize = Math.max(0, Math.min(1, kellySize)); // Clamp to [0, 1]

        // Apply Kelly fraction and confidence adjustment
        positionSize = kellySize * kelly_fraction * confidence;
        positionSize = Math.min(0.10, positionSize); // Max 10% of capital per trade
      }

      const positionDollars = positionSize * capital;

      // Liquidity analysis
      const spread = bestAsk - bestBid;
      const spreadPct = (spread / marketProb) * 100;
      const volume24h = marketData.volume_24h || 0;
      const liquidity = marketData.liquidity || marketData.open_interest || 0;

      const executionFeasibility =
        positionDollars < liquidity * 0.05 // Position < 5% of liquidity
          ? 'GOOD'
          : positionDollars < liquidity * 0.15
          ? 'MODERATE'
          : 'POOR';

      // Risk assessment
      const riskFactors = [];
      if (spreadPct > 3) riskFactors.push(`Wide spread (${spreadPct.toFixed(1)}%)`);
      if (volume24h < 1000) riskFactors.push('Low volume (<$1,000 24h)');
      if (liquidity < 5000) riskFactors.push('Low liquidity (<$5,000)');
      if (confidence < 0.7) riskFactors.push(`Low confidence (${(confidence * 100).toFixed(0)}%)`);
      if (absEdge < 0.10) riskFactors.push(`Small edge (${(absEdge * 100).toFixed(1)}%)`);

      // Store analysis in database
      const dbPath = resolve(process.cwd(), 'store/messages.db');
      const db = new Database(dbPath);

      try {
        db.prepare(
          `INSERT INTO strategy_state (
          timestamp, strategy_id, current_bias, confidence, notes
        ) VALUES (datetime('now'), ?, ?, ?, ?)`
        ).run(
          'opportunity-analysis',
          action,
          confidence,
          JSON.stringify({
            market_id,
            platform,
            question: marketData.question || marketData.title,
            market_prob: marketProb,
            estimated_prob: estimatedProb,
            edge,
            action,
            position_size: positionSize,
            position_dollars: positionDollars,
            risk_factors: riskFactors,
          })
        );
      } catch (err) {
        // Table might not exist yet, ignore
        console.warn('Could not log to strategy_state:', err);
      } finally {
        db.close();
      }

      return {
        market: {
          id: market_id,
          platform,
          question: marketData.question || marketData.title,
          category: marketData.category,
          close_time: marketData.close_time || marketData.expiration_time,
          url: marketData.url,
        },
        pricing: {
          market_probability: parseFloat((marketProb * 100).toFixed(2)) + '%',
          estimated_probability: parseFloat((estimatedProb * 100).toFixed(2)) + '%',
          edge: parseFloat((edge * 100).toFixed(2)) + '%',
          best_bid: bestBid.toFixed(4),
          best_ask: bestAsk.toFixed(4),
          spread: parseFloat((spreadPct).toFixed(2)) + '%',
        },
        recommendation: {
          action,
          confidence: parseFloat((confidence * 100).toFixed(0)) + '%',
          rationale:
            action === 'NONE'
              ? 'Insufficient edge or confidence for trade'
              : `${action} - Edge: ${(absEdge * 100).toFixed(1)}%, Confidence: ${(confidence * 100).toFixed(0)}%`,
        },
        position_sizing: {
          kelly_size: parseFloat((kellySize * 100).toFixed(2)) + '%',
          recommended_size: parseFloat((positionSize * 100).toFixed(2)) + '%',
          position_dollars: '$' + positionDollars.toFixed(2),
          max_loss:
            action === 'BUY'
              ? '$' + positionDollars.toFixed(2)
              : '$' + (positionDollars * bestBid).toFixed(2),
        },
        liquidity: {
          volume_24h: '$' + volume24h.toLocaleString(),
          open_interest: '$' + liquidity.toLocaleString(),
          execution_feasibility: executionFeasibility,
        },
        risk_assessment: {
          risk_level:
            riskFactors.length === 0 ? 'LOW' : riskFactors.length <= 2 ? 'MODERATE' : 'HIGH',
          risk_factors: riskFactors.length > 0 ? riskFactors : ['No significant risks identified'],
        },
      };
    } catch (error: any) {
      return {
        error: true,
        message: `Failed to analyze opportunity: ${error.message}`,
      };
    }
  },
});
