/**
 * MCP Tool: backtest-strategy
 * Test trading strategy on historical data without real money
 */

import Database from 'better-sqlite3';
import path from 'path';

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI } from './api/common.js';
import { detectRSISignals } from './strategies/rsi-mean-reversion.js';
import { RiskManager, DEFAULT_RISK_LIMITS } from './strategies/risk-manager.js';

interface BacktestInput {
  strategy: string;
  start_date: string;
  end_date: string;
  initial_capital?: number;
  platform?: 'polymarket' | 'kalshi' | 'all';
}

interface BacktestOutput {
  trades: Array<{
    symbol: string;
    entry_date: string;
    exit_date: string;
    entry_price: number;
    exit_price: number;
    size: number;
    pnl: number;
    strategy: string;
  }>;
  final_pnl: number;
  win_rate: number;
  max_drawdown: number;
  total_trades: number;
  winning_trades: number;
  sharpe_ratio: number;
  equity_curve: Array<{ date: string; equity: number }>;
  summary: string;
}

export async function backtestStrategy(
  input: BacktestInput,
): Promise<BacktestOutput> {
  const {
    strategy,
    start_date,
    end_date,
    initial_capital = 10000,
    platform = 'all',
  } = input;

  // Initialize APIs
  const apis: MarketAPI[] = [];
  if (platform === 'all' || platform === 'polymarket') {
    apis.push(new PolymarketAPI());
  }
  if (platform === 'all' || platform === 'kalshi') {
    apis.push(new KalshiAPI());
  }

  // Get all markets
  const allMarkets = (await Promise.all(apis.map(api => api.getAllMarkets()))).flat();

  // Initialize tracking
  let capital = initial_capital;
  const trades: any[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  const openPositions: Map<string, any> = new Map();

  // Risk manager
  const riskManager = new RiskManager(initial_capital, DEFAULT_RISK_LIMITS);

  // Simulate day by day
  const start = new Date(start_date);
  const end = new Date(end_date);
  let currentDate = new Date(start);

  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split('T')[0];

    // For each market, get historical data up to current date
    for (const market of allMarkets) {
      try {
        const api = apis.find(a => a.platform === market.platform);
        if (!api) continue;

        // Get 15 days of data ending at current date
        const dataStart = new Date(currentDate.getTime() - 15 * 24 * 60 * 60 * 1000);
        const historicalData = await api.getHistoricalData(
          market.symbol,
          dataStart.toISOString().split('T')[0],
          dateStr,
        );

        if (historicalData.length < 15) continue;

        // Detect signals
        const signals = detectRSISignals(historicalData, 0.70);

        for (const signal of signals) {
          if (signal.action === 'buy' && !openPositions.has(signal.symbol)) {
            // Validate trade
            const validation = riskManager.validateTrade(
              signal.confidence,
              signal.volatility || 0.05,
              signal.symbol,
              Array.from(openPositions.values()),
              capital,
            );

            if (validation.allowed && validation.positionSize) {
              // Enter position
              const numContracts = validation.positionSize / signal.entryPrice;

              openPositions.set(signal.symbol, {
                symbol: signal.symbol,
                platform: market.platform,
                entryDate: dateStr,
                entryPrice: signal.entryPrice,
                size: numContracts,
                strategy: signal.strategy,
                exitTarget: signal.entryPrice * 1.05, // Exit at 5% profit for backtest
              });
            }
          }

          // Check exit signals
          if (signal.action === 'sell' || signal.strategy === 'rsi_smart_exit') {
            const position = openPositions.get(signal.symbol);

            if (position) {
              // Exit position
              const exitPrice = signal.entryPrice;
              const pnl = (exitPrice - position.entryPrice) * position.size;

              trades.push({
                symbol: position.symbol,
                entry_date: position.entryDate,
                exit_date: dateStr,
                entry_price: position.entryPrice,
                exit_price: exitPrice,
                size: position.size,
                pnl,
                strategy: position.strategy,
              });

              capital += pnl;
              openPositions.delete(signal.symbol);
            }
          }
        }

        // Time-based exits (5-day rule)
        for (const [symbol, position] of openPositions) {
          const entryDate = new Date(position.entryDate);
          const daysSinceEntry =
            (currentDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);

          if (daysSinceEntry >= 5) {
            // Get current price
            const currentData = historicalData[historicalData.length - 1];
            const exitPrice = currentData.price;
            const pnl = (exitPrice - position.entryPrice) * position.size;

            trades.push({
              symbol: position.symbol,
              entry_date: position.entryDate,
              exit_date: dateStr,
              entry_price: position.entryPrice,
              exit_price: exitPrice,
              size: position.size,
              pnl,
              strategy: position.strategy + '_time_stop',
            });

            capital += pnl;
            openPositions.delete(symbol);
          }
        }
      } catch (err) {
        // Skip markets with errors
        continue;
      }
    }

    // Record equity
    equityCurve.push({ date: dateStr, equity: capital });

    // Move to next day
    currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
  }

  // Close any remaining positions at end date
  for (const [symbol, position] of openPositions) {
    const api = apis.find(a => a.platform === position.platform);
    if (!api) continue;

    const finalData = await api.getMarketData(symbol);
    const exitPrice = finalData.price;
    const pnl = (exitPrice - position.entryPrice) * position.size;

    trades.push({
      symbol: position.symbol,
      entry_date: position.entryDate,
      exit_date: end_date,
      entry_price: position.entryPrice,
      exit_price: exitPrice,
      size: position.size,
      pnl,
      strategy: position.strategy + '_forced_exit',
    });

    capital += pnl;
  }

  // Calculate metrics
  const final_pnl = capital - initial_capital;
  const wins = trades.filter(t => t.pnl > 0);
  const win_rate = trades.length > 0 ? wins.length / trades.length : 0;

  // Max drawdown
  let peak = initial_capital;
  let max_drawdown = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = (point.equity - peak) / peak;
    max_drawdown = Math.min(max_drawdown, drawdown);
  }

  // Sharpe ratio
  const returns = trades.map(t => t.pnl / initial_capital);
  const avg_return = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 0
      ? returns.reduce((sum, r) => sum + Math.pow(r - avg_return, 2), 0) / returns.length
      : 0;
  const std_dev = Math.sqrt(variance);
  const sharpe_ratio = std_dev > 0 ? (avg_return / std_dev) * Math.sqrt(252) : 0;

  // Store backtest results
  const db = new Database(
    path.join(process.env.STORE_DIR || '/workspace/project/store', 'messages.db'),
  );

  db.prepare(
    `INSERT INTO backtest_runs (start_date, end_date, strategy, total_trades, win_rate, total_pnl, max_drawdown, sharpe_ratio, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    start_date,
    end_date,
    strategy,
    trades.length,
    win_rate,
    final_pnl,
    max_drawdown,
    sharpe_ratio,
    JSON.stringify({ initial_capital, platform }),
    new Date().toISOString(),
  );

  db.close();

  const summary = `
# Backtest Results: ${strategy}

Period: ${start_date} to ${end_date}
Initial Capital: $${initial_capital.toFixed(2)}
Final Capital: $${capital.toFixed(2)}

## Performance
- Total P&L: $${final_pnl.toFixed(2)} (${((final_pnl / initial_capital) * 100).toFixed(2)}%)
- Win Rate: ${(win_rate * 100).toFixed(1)}% (${wins.length}/${trades.length})
- Max Drawdown: ${(max_drawdown * 100).toFixed(1)}%
- Sharpe Ratio: ${sharpe_ratio.toFixed(2)}

## Comparison to Target
- Win Rate: ${win_rate >= 0.78 ? '✅' : '⚠️'} ${(win_rate * 100).toFixed(1)}% vs 78% target
- Max Drawdown: ${Math.abs(max_drawdown) <= 0.25 ? '✅' : '❌'} ${(max_drawdown * 100).toFixed(1)}% vs -25% limit
- Sharpe Ratio: ${sharpe_ratio >= 0.5 ? '✅' : '⚠️'} ${sharpe_ratio.toFixed(2)} vs 0.5 minimum

${final_pnl > 0 && win_rate >= 0.60 && Math.abs(max_drawdown) <= 0.25 ? '✅ Strategy shows promise. Consider paper trading.' : '⚠️ Strategy needs refinement before live trading.'}
  `.trim();

  return {
    trades,
    final_pnl,
    win_rate,
    max_drawdown,
    total_trades: trades.length,
    winning_trades: wins.length,
    sharpe_ratio,
    equity_curve: equityCurve,
    summary,
  };
}

// MCP tool definition
export const backtestStrategyTool = {
  name: 'trading__backtest_strategy',
  description:
    'Test trading strategy on historical market data without risking real money. Simulates day-by-day trading with full risk management rules applied. Generates equity curve, calculates performance metrics, and compares to expected outcomes. Stores results in backtest_runs table for tracking improvements over time.',
  inputSchema: {
    type: 'object',
    required: ['strategy', 'start_date', 'end_date'],
    properties: {
      strategy: {
        type: 'string',
        description: 'Strategy name to backtest (e.g., "rsi_mean_reversion")',
      },
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format',
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format',
      },
      initial_capital: {
        type: 'number',
        description: 'Starting capital in dollars (default: 10000)',
      },
      platform: {
        type: 'string',
        enum: ['polymarket', 'kalshi', 'all'],
        description: 'Which platform(s) to backtest (default: all)',
      },
    },
  },
  handler: backtestStrategy,
};
