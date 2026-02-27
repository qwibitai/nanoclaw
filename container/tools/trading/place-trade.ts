/**
 * MCP Tool: place-trade
 * Execute a trade on prediction markets (paper or live mode)
 */

import Database from 'better-sqlite3';
import path from 'path';

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI, Order } from './api/common.js';
import { RiskManager, DEFAULT_RISK_LIMITS } from './strategies/risk-manager.js';

interface PlaceTradeInput {
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  action: 'buy' | 'sell';
  size?: number; // Optional: will be calculated by risk manager if not provided
  limit_price?: number;
  mode?: 'paper' | 'live';
  stop_loss?: number;
  time_stop_days?: number;
  confidence?: number; // For risk management calculation
  volatility?: number; // For risk management calculation
}

interface PlaceTradeOutput {
  success: boolean;
  order_id?: string;
  position_id?: number;
  filled_price?: number;
  size: number;
  reasoning: string;
  error?: string;
}

export async function placeTrade(input: PlaceTradeInput): Promise<PlaceTradeOutput> {
  const {
    symbol,
    platform,
    action,
    limit_price,
    mode = 'paper',
    stop_loss,
    time_stop_days = 5,
    confidence = 0.75,
    volatility = 0.05,
  } = input;

  // Initialize API
  const api: MarketAPI =
    platform === 'polymarket' ? new PolymarketAPI() : new KalshiAPI();

  // Initialize database
  const db = new Database(
    path.join(process.env.STORE_DIR || '/workspace/project/store', 'messages.db'),
  );

  try {
    // Get current portfolio value from performance_metrics
    const latestMetrics = db
      .prepare(`SELECT * FROM performance_metrics ORDER BY date DESC LIMIT 1`)
      .get() as any;

    const portfolioValue = latestMetrics
      ? 10000 + latestMetrics.total_pnl
      : 10000; // Start with $10k

    // Get open positions for risk management
    const openPositions = db
      .prepare(`SELECT * FROM trading_positions WHERE status = 'open'`)
      .all() as any[];

    // Initialize risk manager
    const riskManager = new RiskManager(10000, DEFAULT_RISK_LIMITS); // Initial capital $10k

    // Calculate position size if not provided
    let finalSize = input.size;

    if (!finalSize && action === 'buy') {
      const validation = riskManager.validateTrade(
        confidence,
        volatility,
        symbol,
        openPositions,
        portfolioValue,
      );

      if (!validation.allowed) {
        db.close();
        return {
          success: false,
          size: 0,
          reasoning: validation.message || 'Trade rejected by risk manager',
          error: validation.message,
        };
      }

      finalSize = validation.positionSize!;
    }

    if (!finalSize) {
      throw new Error('Position size must be provided for sell orders');
    }

    // Create order
    const order: Order = {
      symbol,
      platform,
      action,
      size: finalSize,
      limitPrice: limit_price,
      stopLoss: stop_loss,
      timeStopDays: time_stop_days,
    };

    // Place order via API
    const result = await api.placeOrder(order, mode);

    const timestamp = new Date().toISOString();

    // Log order to database
    const orderInsert = db
      .prepare(
        `INSERT INTO trading_orders (platform, symbol, order_type, size, limit_price, status, timestamp, filled_at, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        platform,
        symbol,
        action,
        finalSize,
        limit_price || null,
        result.status,
        timestamp,
        result.status === 'filled' ? timestamp : null,
        result.error || null,
      );

    const orderId = orderInsert.lastInsertRowid as number;

    // If filled and it's a buy order, create position
    let positionId: number | undefined;

    if (result.status === 'filled' && action === 'buy') {
      const positionInsert = db
        .prepare(
          `INSERT INTO trading_positions (symbol, platform, entry_price, size, entry_date, status, strategy, notes)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          symbol,
          platform,
          result.filledPrice || limit_price || 0,
          finalSize,
          timestamp,
          'manual', // Could be extracted from context
          JSON.stringify({
            mode,
            orderId,
            stopLoss: stop_loss,
            timeStopDays: time_stop_days,
            confidence,
            volatility,
          }),
        );

      positionId = positionInsert.lastInsertRowid as number;

      // Update order with position_id
      db.prepare(`UPDATE trading_orders SET position_id = ? WHERE id = ?`).run(
        positionId,
        orderId,
      );
    }

    // If filled and it's a sell order, close position
    if (result.status === 'filled' && action === 'sell') {
      // Find matching open position
      const position = db
        .prepare(
          `SELECT * FROM trading_positions WHERE symbol = ? AND platform = ? AND status = 'open' LIMIT 1`,
        )
        .get(symbol, platform) as any;

      if (position) {
        const pnl =
          (result.filledPrice! - position.entry_price) * position.size;

        db.prepare(
          `UPDATE trading_positions SET status = 'closed', exit_date = ?, exit_price = ?, pnl = ? WHERE id = ?`,
        ).run(timestamp, result.filledPrice, pnl, position.id);

        positionId = position.id;
      }
    }

    db.close();

    const modeLabel = mode === 'paper' ? 'PAPER TRADE' : 'LIVE TRADE';

    return {
      success: true,
      order_id: result.orderId,
      position_id: positionId,
      filled_price: result.filledPrice,
      size: finalSize,
      reasoning: `${modeLabel}: ${action.toUpperCase()} ${finalSize.toFixed(2)} contracts of ${symbol} @ ${result.filledPrice?.toFixed(4) || 'market'}. Order ${result.status}. ${positionId ? `Position ${positionId} ${action === 'buy' ? 'opened' : 'closed'}.` : ''}`,
    };
  } catch (err: any) {
    db.close();
    return {
      success: false,
      size: input.size || 0,
      reasoning: `Trade failed: ${err.message}`,
      error: err.message,
    };
  }
}

// MCP tool definition
export const placeTradeTool = {
  name: 'trading__place_trade',
  description:
    'Execute a trade on prediction markets (Polymarket or Kalshi). Supports paper trading (simulated) and live trading. Automatically calculates position sizing based on risk management rules if size not provided. Enforces drawdown limits, correlation limits, and confidence thresholds.',
  inputSchema: {
    type: 'object',
    required: ['symbol', 'platform', 'action'],
    properties: {
      symbol: {
        type: 'string',
        description: 'Market symbol to trade',
      },
      platform: {
        type: 'string',
        enum: ['polymarket', 'kalshi'],
        description: 'Which platform to trade on',
      },
      action: {
        type: 'string',
        enum: ['buy', 'sell'],
        description: 'Buy to enter position, sell to exit',
      },
      size: {
        type: 'number',
        description:
          'Position size in dollars (optional - will be calculated by risk manager if omitted for buy orders)',
      },
      limit_price: {
        type: 'number',
        description: 'Limit price for order (optional - uses market price if omitted)',
      },
      mode: {
        type: 'string',
        enum: ['paper', 'live'],
        description: 'Paper for simulated trading, live for real money (default: paper)',
      },
      stop_loss: {
        type: 'number',
        description: 'Price at which to auto-exit (optional)',
      },
      time_stop_days: {
        type: 'number',
        description: "Exit after N days if not profitable (default: 5 - Felipe's rule)",
      },
      confidence: {
        type: 'number',
        description: 'Signal confidence 0-1 for risk calculation (default: 0.75)',
      },
      volatility: {
        type: 'number',
        description: 'Market volatility for risk calculation (default: 0.05)',
      },
    },
  },
  handler: placeTrade,
};
