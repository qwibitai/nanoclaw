/**
 * MCP Tool: backtest-strategy
 * Test trading strategy on historical data without real money
 * Supports both live API data and recorded watcher data at sub-daily intervals
 */

import Database from 'better-sqlite3';
import path from 'path';

import { PolymarketAPI } from './api/polymarket.js';
import { KalshiAPI } from './api/kalshi.js';
import { MarketAPI, MarketData } from './api/common.js';
import { detectRSISignals } from './strategies/rsi-mean-reversion.js';
import { RiskManager, DEFAULT_RISK_LIMITS, RiskLimits } from './strategies/risk-manager.js';

interface BacktestInput {
  strategy: string;
  start_date: string;
  end_date: string;
  initial_capital?: number;
  platform?: 'polymarket' | 'kalshi' | 'all';
  data_source?: 'live' | 'recorded';
  watcher_id?: string;
  interval?: '5m' | '15m' | '1h' | '1d';
  risk_params?: Partial<RiskLimits>;
  token_ids?: string[];
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

const INTERVAL_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function loadRecordedData(db: Database.Database, watcherId: string, tokenIds?: string[]): Map<string, MarketData[]> {
  const dataByToken = new Map<string, MarketData[]>();

  let sql = `SELECT * FROM market_data WHERE metadata LIKE ? ORDER BY timestamp ASC`;
  const params: any[] = [`%"watcher_id":"${watcherId}"%`];

  const rows = db.prepare(sql).all(...params) as Array<{
    symbol: string; timestamp: string; price: number;
    volume: number | null; open_interest: number | null;
  }>;

  for (const row of rows) {
    if (tokenIds && tokenIds.length > 0 && !tokenIds.includes(row.symbol)) continue;
    const existing = dataByToken.get(row.symbol) || [];
    existing.push({
      symbol: row.symbol,
      platform: 'polymarket',
      price: row.price,
      volume: row.volume ?? undefined,
      openInterest: row.open_interest ?? undefined,
      timestamp: row.timestamp,
    });
    dataByToken.set(row.symbol, existing);
  }

  return dataByToken;
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
    data_source = 'live',
    watcher_id,
    interval = '1d',
    risk_params,
    token_ids,
  } = input;

  const dbPath = path.join(process.env.STORE_DIR || '/workspace/project/store', 'messages.db');
  const db = new Database(dbPath);

  // Merge custom risk params with defaults
  const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS };
  if (risk_params) {
    if (risk_params.MAX_DRAWDOWN !== undefined) limits.MAX_DRAWDOWN = risk_params.MAX_DRAWDOWN;
    if (risk_params.MAX_POSITION_SIZE !== undefined) limits.MAX_POSITION_SIZE = risk_params.MAX_POSITION_SIZE;
    if (risk_params.MIN_CONFIDENCE !== undefined) limits.MIN_CONFIDENCE = risk_params.MIN_CONFIDENCE;
    if (risk_params.TIME_STOP_DAYS !== undefined) limits.TIME_STOP_DAYS = risk_params.TIME_STOP_DAYS;
    if (risk_params.MAX_CORRELATED_EXPOSURE !== undefined) limits.MAX_CORRELATED_EXPOSURE = risk_params.MAX_CORRELATED_EXPOSURE;
    if (risk_params.VOLATILITY_SCALAR !== undefined) limits.VOLATILITY_SCALAR = risk_params.VOLATILITY_SCALAR;
    if (risk_params.MAX_CONSECUTIVE_LOSSES !== undefined) limits.MAX_CONSECUTIVE_LOSSES = risk_params.MAX_CONSECUTIVE_LOSSES;
    if (risk_params.MIN_SHARPE_RATIO !== undefined) limits.MIN_SHARPE_RATIO = risk_params.MIN_SHARPE_RATIO;
  }

  const riskManager = new RiskManager(initial_capital, limits);

  let capital = initial_capital;
  const trades: any[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  const openPositions: Map<string, any> = new Map();

  const stepMs = INTERVAL_MS[interval] || INTERVAL_MS['1d'];
  const timeStopMs = limits.TIME_STOP_DAYS * 24 * 60 * 60 * 1000;

  if (data_source === 'recorded' && watcher_id) {
    // --- Recorded data mode: step through captured data points ---
    const dataByToken = loadRecordedData(db, watcher_id, token_ids);

    if (dataByToken.size === 0) {
      db.close();
      return emptyResult(initial_capital, strategy, start_date, end_date);
    }

    for (const [tokenId, allData] of dataByToken) {
      // Step through the data at the requested interval
      for (let i = 15; i < allData.length; i++) {
        const windowData = allData.slice(Math.max(0, i - 15), i + 1);
        const currentData = allData[i];
        const dateStr = currentData.timestamp;

        // Detect signals
        const signals = detectRSISignals(windowData, limits.MIN_CONFIDENCE);

        for (const signal of signals) {
          if (signal.action === 'buy' && !openPositions.has(tokenId)) {
            const validation = riskManager.validateTrade(
              signal.confidence,
              signal.volatility || 0.05,
              tokenId,
              Array.from(openPositions.values()),
              capital,
            );

            if (validation.allowed && validation.positionSize) {
              const numContracts = validation.positionSize / signal.entryPrice;
              openPositions.set(tokenId, {
                symbol: tokenId,
                platform: 'polymarket',
                entryDate: dateStr,
                entryPrice: signal.entryPrice,
                size: numContracts,
                strategy: signal.strategy,
              });
            }
          }

          if (signal.action === 'sell' || signal.strategy === 'rsi_smart_exit') {
            const position = openPositions.get(tokenId);
            if (position) {
              const exitPrice = signal.entryPrice;
              const pnl = (exitPrice - position.entryPrice) * position.size;
              trades.push({
                symbol: tokenId,
                entry_date: position.entryDate,
                exit_date: dateStr,
                entry_price: position.entryPrice,
                exit_price: exitPrice,
                size: position.size,
                pnl,
                strategy: position.strategy,
              });
              capital += pnl;
              openPositions.delete(tokenId);
            }
          }
        }

        // Time-based exits
        const position = openPositions.get(tokenId);
        if (position) {
          const entryTime = new Date(position.entryDate).getTime();
          const currentTime = new Date(dateStr).getTime();
          if (currentTime - entryTime >= timeStopMs) {
            const exitPrice = currentData.price;
            const pnl = (exitPrice - position.entryPrice) * position.size;
            trades.push({
              symbol: tokenId,
              entry_date: position.entryDate,
              exit_date: dateStr,
              entry_price: position.entryPrice,
              exit_price: exitPrice,
              size: position.size,
              pnl,
              strategy: position.strategy + '_time_stop',
            });
            capital += pnl;
            openPositions.delete(tokenId);
          }
        }

        // Record equity at each step
        equityCurve.push({ date: dateStr, equity: capital });
      }
    }

    // Close remaining positions at last data point
    for (const [tokenId, position] of openPositions) {
      const dataForToken = dataByToken.get(tokenId);
      if (!dataForToken || dataForToken.length === 0) continue;
      const lastPoint = dataForToken[dataForToken.length - 1];
      const pnl = (lastPoint.price - position.entryPrice) * position.size;
      trades.push({
        symbol: tokenId,
        entry_date: position.entryDate,
        exit_date: lastPoint.timestamp,
        entry_price: position.entryPrice,
        exit_price: lastPoint.price,
        size: position.size,
        pnl,
        strategy: position.strategy + '_forced_exit',
      });
      capital += pnl;
    }
  } else {
    // --- Live API data mode (original behavior) ---
    const apis: MarketAPI[] = [];
    if (platform === 'all' || platform === 'polymarket') apis.push(new PolymarketAPI());
    if (platform === 'all' || platform === 'kalshi') apis.push(new KalshiAPI());

    let allMarkets: MarketData[];
    if (token_ids && token_ids.length > 0) {
      // Use specific token IDs
      allMarkets = token_ids.map(id => ({
        symbol: id,
        platform: 'polymarket' as const,
        price: 0,
        timestamp: new Date().toISOString(),
      }));
    } else {
      allMarkets = (await Promise.all(apis.map(api => api.getAllMarkets()))).flat();
    }

    const start = new Date(start_date);
    const end = new Date(end_date);
    let currentDate = new Date(start);

    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];

      for (const market of allMarkets) {
        try {
          const api = apis.find(a => a.platform === market.platform);
          if (!api) continue;

          const lookback = interval === '1d' ? 15 : Math.ceil(15 * stepMs / (24 * 60 * 60 * 1000)) + 1;
          const dataStart = new Date(currentDate.getTime() - lookback * 24 * 60 * 60 * 1000);
          const historicalData = await api.getHistoricalData(
            market.symbol,
            dataStart.toISOString().split('T')[0],
            dateStr,
            interval,
          );

          if (historicalData.length < 15) continue;

          const signals = detectRSISignals(historicalData, limits.MIN_CONFIDENCE);

          for (const signal of signals) {
            if (signal.action === 'buy' && !openPositions.has(signal.symbol)) {
              const validation = riskManager.validateTrade(
                signal.confidence,
                signal.volatility || 0.05,
                signal.symbol,
                Array.from(openPositions.values()),
                capital,
              );

              if (validation.allowed && validation.positionSize) {
                const numContracts = validation.positionSize / signal.entryPrice;
                openPositions.set(signal.symbol, {
                  symbol: signal.symbol,
                  platform: market.platform,
                  entryDate: dateStr,
                  entryPrice: signal.entryPrice,
                  size: numContracts,
                  strategy: signal.strategy,
                });
              }
            }

            if (signal.action === 'sell' || signal.strategy === 'rsi_smart_exit') {
              const position = openPositions.get(signal.symbol);
              if (position) {
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

          // Time-based exits
          for (const [symbol, position] of openPositions) {
            const entryDate = new Date(position.entryDate);
            const elapsed = currentDate.getTime() - entryDate.getTime();
            if (elapsed >= timeStopMs) {
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
        } catch {
          continue;
        }
      }

      equityCurve.push({ date: dateStr, equity: capital });
      currentDate = new Date(currentDate.getTime() + stepMs);
    }

    // Close remaining positions
    for (const [symbol, position] of openPositions) {
      const api = apis.find(a => a.platform === position.platform);
      if (!api) continue;
      try {
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
      } catch {
        // Skip
      }
    }
  }

  // Calculate metrics
  const final_pnl = capital - initial_capital;
  const wins = trades.filter(t => t.pnl > 0);
  const win_rate = trades.length > 0 ? wins.length / trades.length : 0;

  let peak = initial_capital;
  let max_drawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = (point.equity - peak) / peak;
    max_drawdown = Math.min(max_drawdown, drawdown);
  }

  const returns = trades.map(t => t.pnl / initial_capital);
  const avg_return = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avg_return, 2), 0) / returns.length
    : 0;
  const std_dev = Math.sqrt(variance);
  const sharpe_ratio = std_dev > 0 ? (avg_return / std_dev) * Math.sqrt(252) : 0;

  // Store backtest results
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
    JSON.stringify({ initial_capital, platform, data_source, watcher_id, interval, risk_params }),
    new Date().toISOString(),
  );

  db.close();

  const summary = `
# Backtest Results: ${strategy}

Period: ${start_date} to ${end_date}
Data Source: ${data_source}${watcher_id ? ` (watcher: ${watcher_id})` : ''}
Interval: ${interval}
Initial Capital: $${initial_capital.toFixed(2)}
Final Capital: $${capital.toFixed(2)}

## Performance
- Total P&L: $${final_pnl.toFixed(2)} (${((final_pnl / initial_capital) * 100).toFixed(2)}%)
- Win Rate: ${(win_rate * 100).toFixed(1)}% (${wins.length}/${trades.length})
- Max Drawdown: ${(max_drawdown * 100).toFixed(1)}%
- Sharpe Ratio: ${sharpe_ratio.toFixed(2)}

## Comparison to Target
- Win Rate: ${win_rate >= 0.78 ? 'PASS' : 'WARN'} ${(win_rate * 100).toFixed(1)}% vs 78% target
- Max Drawdown: ${Math.abs(max_drawdown) <= 0.25 ? 'PASS' : 'FAIL'} ${(max_drawdown * 100).toFixed(1)}% vs -25% limit
- Sharpe Ratio: ${sharpe_ratio >= 0.5 ? 'PASS' : 'WARN'} ${sharpe_ratio.toFixed(2)} vs 0.5 minimum

${final_pnl > 0 && win_rate >= 0.60 && Math.abs(max_drawdown) <= 0.25 ? 'Strategy shows promise. Consider paper trading.' : 'Strategy needs refinement before live trading.'}
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

function emptyResult(initialCapital: number, strategy: string, startDate: string, endDate: string): BacktestOutput {
  return {
    trades: [],
    final_pnl: 0,
    win_rate: 0,
    max_drawdown: 0,
    total_trades: 0,
    winning_trades: 0,
    sharpe_ratio: 0,
    equity_curve: [],
    summary: `No data available for backtest. Strategy: ${strategy}, Period: ${startDate} to ${endDate}`,
  };
}

// MCP tool definition
export const backtestStrategyTool = {
  name: 'trading__backtest_strategy',
  description:
    'Test trading strategy on historical market data without risking real money. Supports live API data or recorded watcher data at sub-daily intervals (5m, 15m, 1h, 1d). Simulates trading with full risk management rules. Generates equity curve, calculates performance metrics, and compares to expected outcomes.',
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
      data_source: {
        type: 'string',
        enum: ['live', 'recorded'],
        description: 'Use live API data or recorded watcher data (default: live)',
      },
      watcher_id: {
        type: 'string',
        description: 'Watcher ID to use when data_source is "recorded"',
      },
      interval: {
        type: 'string',
        enum: ['5m', '15m', '1h', '1d'],
        description: 'Step interval for backtest (default: 1d)',
      },
      risk_params: {
        type: 'object',
        description: 'Override risk limits: MAX_DRAWDOWN, MAX_POSITION_SIZE, MIN_CONFIDENCE, TIME_STOP_DAYS, etc.',
      },
      token_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific token IDs to backtest on',
      },
    },
  },
  handler: backtestStrategy,
};
