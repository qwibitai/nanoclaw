# NanoClaw Prediction Market Trading Bot

Complete automated trading system for Polymarket and Kalshi with multi-agent analysis, risk management, and self-improvement.

## 🎯 Quick Start

### Paper Trading (Safe - No Real Money)

```bash
# 1. Analyze markets for signals
Use tool: trading__analyze_market
{
  "platform": "all",
  "lookback_days": 14,
  "min_confidence": 0.70
}

# 2. Execute a paper trade
Use tool: trading__place_trade
{
  "symbol": "TRUMP_2024",
  "platform": "polymarket",
  "action": "buy",
  "mode": "paper",
  "confidence": 0.80
}

# 3. Review performance
Use tool: trading__review_performance
{
  "period_days": 30
}
```

## 📊 System Architecture

### Database Tables (6)

Created in `/workspace/project/src/db.ts`:

1. **trading_positions** - Track open/closed positions with P&L
2. **trading_orders** - Order execution history
3. **market_data** - Historical prices and volumes
4. **strategy_state** - Signal detection logs
5. **performance_metrics** - Daily performance stats
6. **backtest_runs** - Historical backtests

### MCP Tools (4)

Located in `/workspace/project/container/tools/trading/`:

1. **trading__analyze_market** - Scan markets for signals
   - RSI mean reversion (78% win rate strategy)
   - Volatility contraction patterns
   - Multi-platform support (Polymarket + Kalshi)

2. **trading__place_trade** - Execute trades
   - Paper mode (default) or live mode
   - Automatic position sizing via Risk Manager
   - Stop-loss and time-stop enforcement

3. **trading__review_performance** - Analyze outcomes
   - Calculate win rate, Sharpe ratio, drawdown
   - Identify prompt adjustments
   - Self-improvement recommendations

4. **trading__backtest_strategy** - Historical testing
   - Test strategies on past data
   - Generate equity curves
   - Validate before live trading

### Multi-Agent System (7 specialists)

Prompts in `/workspace/group/memory/trading/strategy-prompts/`:

1. **Fundamental Analyst** - Event probability & fair value
2. **Technical Analyst** - RSI, volatility, entry/exit points
3. **Sentiment Analyst** - News, social, market psychology
4. **Bull Researcher** - Build strongest case FOR trade
5. **Bear Researcher** - Build strongest case AGAINST trade
6. **Risk Manager** - Final go/no-go with position sizing
7. **Trader** - Orchestrate workflow and execute

## 🛡️ Risk Management

### Hard-Coded Limits (NEVER OVERRIDE)

```typescript
MAX_DRAWDOWN: 25%          // Halt trading if exceeded
MAX_POSITION_SIZE: 10%     // Per trade
MAX_CORRELATED_EXPOSURE: 30%
MIN_CONFIDENCE: 70%
TIME_STOP: 5 days          // Felipe's rule
MAX_CONSECUTIVE_LOSSES: 8  // Alert threshold
MIN_SHARPE_RATIO: 0.5
```

### Position Sizing Formula

```
Base Size = 10% of portfolio
Confidence Multiplier = (Signal Confidence / 70%)
Volatility Adjustment = (1 - Volatility × 0.5)

Final Size = Base Size × Confidence Multiplier × Volatility Adjustment
```

## 📈 Trading Strategies

### 1. RSI Mean Reversion (Primary)

**Entry**: RSI(2) < 10
**Exit**: Price > Yesterday's High (smart exit)
**Expected**: 78.5% win rate, -23.73% max drawdown

Based on research from QuantifiedStrategies:
- Strategy tested over 33 years
- $100K → $1.7M
- Works best on liquid markets

### 2. Volatility Contraction Pattern (Secondary)

**Entry**: 7-day vol < 14-day vol < 30-day vol
**Exit**: Breakout confirmed or 5-day stop
**Expected**: 65% win rate, higher avg gains

## 🤖 Daily Workflow

### Automated Schedule

**3:50 PM EST** - Market Scan
```
Tool: trading__analyze_market
- Scans all Polymarket & Kalshi markets
- Detects RSI signals and VCP patterns
- Stores signals in strategy_state table
```

**3:51-3:55 PM EST** - Multi-Agent Analysis
```
For each high-confidence signal:
1. Spawn Technical, Fundamental, Sentiment analysts (parallel)
2. Spawn Bull & Bear researchers (parallel)
3. Spawn Risk Manager (sequential)
```

**3:58 PM EST** - Execution
```
Tool: trading__place_trade (paper mode)
- Execute GO decisions from Risk Manager
- Log to trading_positions and trading_orders
- Document reasoning in decisions/ folder
```

**Weekly (Sundays 10 AM)** - Performance Review
```
Tool: trading__review_performance
- Analyze last 7 days of trades
- Calculate metrics vs targets
- Suggest prompt adjustments
- Update performance_metrics table
```

## 📁 File Structure

```
/workspace/project/
  container/tools/trading/
    analyze-market.ts         # Market scanning tool
    place-trade.ts            # Order execution tool
    review-performance.ts     # Performance analysis tool
    backtest-strategy.ts      # Historical testing tool
    index.ts                  # Tool exports & docs

    api/
      common.ts               # Shared types
      polymarket.ts           # Polymarket API
      kalshi.ts              # Kalshi API

    strategies/
      rsi-mean-reversion.ts   # RSI calculations & signals
      risk-manager.ts         # Position sizing & limits

  src/
    db.ts                     # Database schema (6 trading tables)
    monitor-server.ts         # API endpoints (3 trading endpoints)

/workspace/group/memory/trading/
  strategy-prompts/           # 7 agent prompts
    fundamental-analyst.md
    technical-analyst.md
    sentiment-analyst.md
    bull-researcher.md
    bear-researcher.md
    risk-manager.md
    trader.md

  decisions/                  # Daily decision logs (JSONL)
  theses/                     # Trade thesis documents
  README.md                   # This file
```

## 🚦 Paper Trading → Live Trading Graduation

### Requirements (Must meet ALL)

- [ ] 100+ paper trades executed
- [ ] Win rate > 60% (target: 78%)
- [ ] Max drawdown < 25%
- [ ] Sharpe ratio > 0.5
- [ ] No consecutive losses > 10
- [ ] Backtest validates strategy on historical data

### Graduation Process

1. Run `trading__review_performance({ period_days: 90 })`
2. Verify all metrics meet thresholds
3. Run `trading__backtest_strategy` on historical data
4. If validated, change `mode: "live"` in execution script
5. Start with 1% position sizes, gradually increase

## 🔍 Monitoring Dashboard

### API Endpoints

**Trading Positions**
```
GET /api/trading/positions?status=open&limit=50
Returns: Array of positions with P&L
```

**Performance Metrics**
```
GET /api/trading/performance?days=30
Returns: { metrics: [], recent_trades: [] }
```

**Recent Signals**
```
GET /api/trading/signals?limit=20
Returns: Latest market scan results
```

### Dashboard URL

```
http://localhost:9100
```

Access from any computer on your network (replace localhost with server hostname).

## 🧪 Testing & Validation

### Test Tools Work

```bash
# 1. Test market analysis
Use: trading__analyze_market({ platform: "polymarket", lookback_days: 7 })

# Expected: Returns list of signals with confidence scores

# 2. Test paper trading
Use: trading__place_trade({
  symbol: "TEST_MARKET",
  platform: "polymarket",
  action: "buy",
  mode: "paper",
  size: 100
})

# Expected: Order confirmed, position created in database

# 3. Test backtest
Use: trading__backtest_strategy({
  strategy: "rsi_mean_reversion",
  start_date: "2024-01-01",
  end_date: "2024-02-01",
  initial_capital: 10000
})

# Expected: Trades simulated, equity curve generated
```

### Verify Database

```bash
sqlite3 /workspace/project/store/messages.db

SELECT * FROM trading_positions LIMIT 5;
SELECT * FROM strategy_state ORDER BY timestamp DESC LIMIT 5;
SELECT * FROM performance_metrics;
```

## 📚 Research Foundation

System based on 13 trading research summaries:

1. **RSI Trading Strategies** (QuantifiedStrategies)
   - 78.5% win rate with RSI < 10 entry
   - Smart exit strategy (price > yesterday's high)

2. **Probabilistic Thinking** (Algomatic Trading)
   - Judge by distributions, not individual outcomes
   - Pre-accept 35-40% failure rate

3. **Multi-Agent Trading** (arXiv 2024)
   - Multi-agent systems outperform single agents
   - Diversity improves decision quality

4. **End-of-Day Execution** (Felipe Guirao)
   - 3:58 PM execution reduces emotional interference
   - Allows analysis without intraday stress

5. **Risk Management** (Multiple sources)
   - 25% max drawdown (Moderate risk tolerance)
   - 5-day time stops prevent holding losers
   - Position sizing based on Kelly Criterion / 2

## 🐛 Troubleshooting

### "Trading tables don't exist"
```bash
# Restart orchestrator to run migrations
docker restart nanoclaw_orchestrator
```

### "Tool not found: trading__*"
```typescript
// Check tools are exported in:
/workspace/project/container/tools/trading/index.ts

// Verify imports in MCP server
```

### "Paper trades not appearing in database"
```bash
# Check database path
echo $STORE_DIR

# Verify table exists
sqlite3 $STORE_DIR/messages.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'trading%';"
```

## 🎯 Next Steps

1. **Test the system**
   - Run `trading__analyze_market` manually
   - Execute a test paper trade
   - Review results in dashboard

2. **Set up scheduled tasks**
   - Daily 3:50 PM market scan
   - Daily 3:58 PM execution
   - Weekly performance review

3. **Build trading history**
   - Run 100+ paper trades
   - Iterate on agent prompts
   - Track what works

4. **Validate for live trading**
   - Meet all graduation criteria
   - Backtest extensively
   - Start small (1% positions)

## 📞 Support

For questions or issues:
- Check `/workspace/group/memory/trading/decisions/*.jsonl` for execution logs
- Review agent prompts in `strategy-prompts/`
- Monitor dashboard at http://localhost:9100
- Check orchestrator logs for errors

---

**Remember**: This is a PAPER TRADING SYSTEM by default. No real money is at risk until you explicitly change `mode: "live"` after meeting graduation criteria.
