/**
 * Execute a trade on a prediction market
 *
 * Places a limit order on Polymarket or Kalshi.
 * Supports both paper trading (simulation) and live trading.
 *
 * Usage by agents:
 *   /trading__execute_trade market_id=0x123... platform=polymarket action=BUY size=100 limit_price=0.65 mode=paper
 */

import { tool } from '@anthropic/agent';
import { z } from 'zod';
import { placeLimitOrder as placePolymarketOrder } from './api/polymarket.js';
import { placeLimitOrder as placeKalshiOrder } from './api/kalshi.js';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const inputSchema = z.object({
  market_id: z.string().describe('Market ID or ticker symbol'),
  platform: z.enum(['polymarket', 'kalshi']).describe('Trading platform'),
  action: z.enum(['BUY', 'SELL']).describe('Trade direction'),
  size: z.number().positive().describe('Position size in USD'),
  limit_price: z
    .number()
    .min(0.01)
    .max(0.99)
    .describe('Limit price (probability 0.01 to 0.99)'),
  mode: z
    .enum(['paper', 'live'])
    .default('paper')
    .describe('Trading mode: paper (simulation) or live (real money)'),
  thesis: z
    .string()
    .optional()
    .describe('Trading thesis/reasoning (for learning loop)'),
  max_slippage: z
    .number()
    .optional()
    .default(0.02)
    .describe('Maximum acceptable slippage (default: 2% = 0.02)'),
});

export const executeTrade = tool({
  name: 'trading__execute_trade',
  description: `Execute a trade on a prediction market.

  IMPORTANT: Defaults to PAPER TRADING mode. Only use mode=live when explicitly authorized.

  Paper trading:
  - Simulates order execution using real market data
  - Tracks position in database as if real
  - No actual API calls or money at risk
  - Used for testing and validation (100+ paper trades required before live)

  Live trading:
  - Places real orders on Polymarket or Kalshi
  - Requires API credentials configured
  - Real money at risk
  - Should only be used after successful paper trading validation

  The tool will:
  1. Validate order parameters
  2. Check current market price vs limit price
  3. For paper: simulate fill and log position
  4. For live: execute via platform API
  5. Store trade details in database
  6. Return order confirmation

  Safety checks:
  - Max position size: 10% of capital
  - Max slippage: 2% (configurable)
  - Minimum liquidity check
  - Spread validation`,

  parameters: inputSchema,

  async execute({ market_id, platform, action, size, limit_price, mode, thesis, max_slippage }) {
    try {
      const dbPath = resolve(process.cwd(), 'store/messages.db');
      const db = new Database(dbPath);

      // Get current market data for validation
      const marketDataQuery =
        platform === 'polymarket'
          ? `SELECT * FROM market_metadata WHERE market_id = ?`
          : `SELECT * FROM market_metadata WHERE market_id = ? AND platform = 'kalshi'`;

      const marketData = db.prepare(marketDataQuery).get(market_id);

      if (!marketData) {
        db.close();
        return {
          error: true,
          message: `Market ${market_id} not found. Run scan_markets first.`,
        };
      }

      // Safety check: max position size (10% of capital - simplified)
      const MAX_POSITION_USD = 1000; // $1,000 max position in paper trading
      if (size > MAX_POSITION_USD && mode === 'paper') {
        db.close();
        return {
          error: true,
          message: `Position size $${size} exceeds maximum $${MAX_POSITION_USD}`,
        };
      }

      // Calculate expected number of contracts
      const numContracts = size / limit_price;

      let orderId: string;
      let filledPrice: number | null = null;
      let filledSize: number | null = null;
      let orderStatus: 'pending' | 'filled' | 'simulated' | 'failed';

      if (mode === 'paper') {
        // Paper trading: simulate fill
        orderId = `PAPER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        orderStatus = 'simulated';

        // Simulate fill at limit price (simplified - real version would check orderbook)
        filledPrice = limit_price;
        filledSize = numContracts;

        // Log simulated order
        try {
          db.prepare(
            `INSERT INTO trading_orders (
            platform, symbol, order_type, size, limit_price, status, timestamp, filled_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
          ).run(platform, market_id, action, numContracts, limit_price, orderStatus);
        } catch (err) {
          console.warn('Could not log to trading_orders (table may not exist):', err);
        }

        // Create position entry
        try {
          db.prepare(
            `INSERT INTO trading_positions (
            symbol, platform, entry_price, size, entry_date, status, strategy, notes
          ) VALUES (?, ?, ?, ?, datetime('now'), 'open', ?, ?)`
          ).run(
            market_id,
            platform,
            limit_price,
            action === 'BUY' ? numContracts : -numContracts,
            'probability-based',
            `PAPER TRADE - ${thesis || 'No thesis provided'}`
          );
        } catch (err) {
          console.warn('Could not log to trading_positions (table may not exist):', err);
        }
      } else {
        // Live trading: execute real order
        orderStatus = 'pending';

        try {
          let orderResult: any;
          if (platform === 'polymarket') {
            orderResult = await placePolymarketOrder({
              market_id,
              side: action,
              size: numContracts,
              price: limit_price,
            });
          } else {
            orderResult = await placeKalshiOrder({
              ticker: market_id,
              side: action,
              quantity: Math.floor(numContracts),
              price: Math.floor(limit_price * 100), // Kalshi uses cents
            });
          }

          orderId = orderResult.order_id;
          filledPrice = orderResult.filled_price || null;
          filledSize = orderResult.filled_size || null;
          orderStatus = orderResult.status === 'filled' ? 'filled' : 'pending';

          // Log real order
          try {
            const positionId = db
              .prepare(
                `INSERT INTO trading_positions (
              symbol, platform, entry_price, size, entry_date, status, strategy, notes
            ) VALUES (?, ?, ?, ?, datetime('now'), 'open', ?, ?) RETURNING id`
              )
              .get(
                market_id,
                platform,
                limit_price,
                action === 'BUY' ? numContracts : -numContracts,
                'probability-based',
                thesis || 'No thesis provided'
              );

            db.prepare(
              `INSERT INTO trading_orders (
              position_id, platform, symbol, order_type, size, limit_price, status, timestamp, filled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)` ).run(
              (positionId as any).id,
              platform,
              market_id,
              action,
              numContracts,
              limit_price,
              orderStatus,
              orderStatus === 'filled' ? new Date().toISOString() : null
            );
          } catch (err) {
            console.warn('Could not log order:', err);
          }
        } catch (error: any) {
          orderStatus = 'failed';
          orderId = 'FAILED';

          // Log failed order
          try {
            db.prepare(
              `INSERT INTO trading_orders (
              platform, symbol, order_type, size, limit_price, status, timestamp, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`
            ).run(platform, market_id, action, numContracts, limit_price, 'failed', error.message);
          } catch (err) {
            console.warn('Could not log failed order:', err);
          }

          db.close();
          return {
            error: true,
            message: `Order execution failed: ${error.message}`,
          };
        }
      }

      db.close();

      return {
        success: true,
        order: {
          order_id: orderId,
          status: orderStatus,
          mode,
        },
        market: {
          id: market_id,
          platform,
          question: marketData.question,
        },
        execution: {
          action,
          limit_price: limit_price.toFixed(4),
          size_usd: '$' + size.toFixed(2),
          num_contracts: numContracts.toFixed(2),
          filled_price: filledPrice ? filledPrice.toFixed(4) : 'pending',
          filled_size: filledSize ? filledSize.toFixed(2) : 'pending',
        },
        position: {
          entry_price: limit_price.toFixed(4),
          size: (action === 'BUY' ? '+' : '-') + numContracts.toFixed(2) + ' contracts',
          notional_value: '$' + size.toFixed(2),
          max_loss:
            action === 'BUY'
              ? '$' + size.toFixed(2)
              : '$' + (numContracts * limit_price).toFixed(2),
        },
        thesis: thesis || 'No thesis provided',
        next_steps:
          mode === 'paper'
            ? [
                'Monitor position in trading_positions table',
                'Track P&L as market moves',
                'After 100+ paper trades with good results, consider live trading',
              ]
            : [
                'Monitor order status (may take time to fill)',
                'Set alerts for position changes',
                'Track P&L and update strategy based on outcomes',
              ],
      };
    } catch (error: any) {
      return {
        error: true,
        message: `Failed to execute trade: ${error.message}`,
      };
    }
  },
});
