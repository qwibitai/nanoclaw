/**
 * Trading Tools Index
 * Exports all trading MCP tools for NanoClaw
 */

// ===========================================================================
// PREDICTION MARKET TOOLS (Current - Use These)
// ===========================================================================
export { analyzeEventProbabilityTool, analyzeEventProbability } from './analyze-event-probability.js';
export { detectNewsCatalystTool, detectNewsCatalyst } from './detect-news-catalyst.js';
export { assessLiquidityTool, assessLiquidity } from './assess-liquidity.js';

// ===========================================================================
// GENERAL TRADING TOOLS (Platform-Agnostic)
// ===========================================================================
export { placeTradeTool, placeTrade } from './place-trade.js';
export { reviewPerformanceTool, reviewPerformance } from './review-performance.js';
export { backtestStrategyTool, backtestStrategy } from './backtest-strategy.js';

// ===========================================================================
// DEPRECATED - STOCK TRADING TOOLS (Do NOT Use for Prediction Markets)
// ===========================================================================
// These tools apply stock trading logic (RSI mean reversion, intraday scalping)
// which does NOT work for prediction markets.
//
// For prediction markets, use analyze-event-probability instead.
// Kept for reference only.
export { analyzeMarketTool, analyzeMarket } from './analyze-market.js';
export { analyzeMarketIntradayTool, analyzeMarketIntraday } from './analyze-market-intraday.js';

// Export all tools array for easy registration
export const tradingTools = [
  // Prediction Market Tools (PRIMARY)
  analyzeEventProbabilityTool,
  detectNewsCatalystTool,
  assessLiquidityTool,

  // General Tools
  placeTradeTool,
  reviewPerformanceTool,
  backtestStrategyTool,

  // Deprecated (but still exported for backwards compatibility)
  // analyzeMarketTool,  // Commented out - use analyze-event-probability instead
  // analyzeMarketIntradayTool,  // Commented out - not applicable to PM
];

// Tool usage documentation
export const TRADING_TOOLS_DOCS = `
# Trading Tools

NanoClaw includes a complete prediction market trading bot with paper trading mode.

## Available Tools

### 1. trading__analyze_market
Scan Polymarket and Kalshi for trading signals using RSI and momentum strategies.

**Usage:**
\`\`\`
{
  "platform": "all",        // polymarket, kalshi, or all
  "strategy": "all",        // rsi_mean_reversion, momentum, or all
  "lookback_days": 14,      // Historical data to analyze
  "min_confidence": 0.70    // Minimum confidence threshold
}
\`\`\`

**Returns:** List of signals ranked by confidence with reasoning.

### 2. trading__place_trade
Execute trades in paper or live mode with automatic risk management.

**Usage:**
\`\`\`
{
  "symbol": "TRUMP_2024",
  "platform": "polymarket",
  "action": "buy",          // buy or sell
  "mode": "paper",          // paper or live (default: paper)
  "confidence": 0.80,       // For position sizing
  "volatility": 0.05        // For position sizing
}
\`\`\`

**Returns:** Order confirmation with position ID and filled price.

### 3. trading__review_performance
Analyze trading performance and suggest improvements.

**Usage:**
\`\`\`
{
  "period_days": 30,        // Days to analyze
  "min_trades": 10          // Minimum trades required
}
\`\`\`

**Returns:** Metrics, insights, and suggested prompt adjustments.

### 4. trading__backtest_strategy
Test strategies on historical data without risking money.

**Usage:**
\`\`\`
{
  "strategy": "rsi_mean_reversion",
  "start_date": "2024-01-01",
  "end_date": "2024-02-27",
  "initial_capital": 10000
}
\`\`\`

**Returns:** Trades, equity curve, performance metrics, and summary.

## Risk Management

All trades are subject to hard-coded limits:
- Max drawdown: 25%
- Max position size: 10% of portfolio
- Min confidence: 70%
- Time stop: 5 days (Felipe's rule)
- Max consecutive losses alert: 8

## Paper Trading Mode

**Default mode is PAPER** - all trades are simulated using real market data.

### Graduation Criteria for Live Trading:
- 100+ paper trades
- Win rate > 60%
- Max drawdown < 25%
- Sharpe ratio > 0.5
- No consecutive losses > 10

## Daily Workflow

1. **3:50 PM EST**: Run analyze_market to scan all markets
2. **3:58 PM EST**: Review signals, execute high-confidence trades
3. **Weekly**: Run review_performance, adjust prompts if needed

## Database Tables

- \`trading_positions\`: Open and closed positions
- \`trading_orders\`: All order history
- \`market_data\`: Market prices and volumes
- \`strategy_state\`: Signal detection history
- \`performance_metrics\`: Daily performance stats
- \`backtest_runs\`: Historical backtest results

## Example Multi-Agent Workflow

\`\`\`
1. Orchestrator: "Run analyze_market at 3:50 PM"
2. Fundamental Analyst: Review top 3 signals
3. Sentiment Analyst: Check news/social for each
4. Technical Analyst: Validate RSI calculations
5. Bull Researcher: Build case FOR each signal
6. Bear Researcher: Build case AGAINST each signal
7. Risk Manager: Validate position sizes and limits
8. Trader: Execute approved trades via place_trade
\`\`\`
`;
