# pmxt.dev Polymarket Data Archive

**Source**: https://archive.pmxt.dev/Polymarket
**Date Discovered**: 2026-02-27
**Topics**: Prediction markets, Backtesting, Data sources

---

## Summary

Free historical Polymarket data archive providing hourly orderbook snapshots and trade data in Parquet format. Critical resource for backtesting prediction market trading strategies.

---

## What It Provides

### Data Format
- **Format**: Parquet files (compressed columnar storage)
- **Frequency**: Hourly snapshots
- **Window**: Rolling ~3 days of recent data
- **Size**: 357-678 MB per hourly file

### Data Types
- Orderbook snapshots (bid/ask prices, depth)
- Trade data (executed trades, volumes)
- Market metadata (token IDs, market IDs)

### Access
- Direct HTTP downloads from https://archive.pmxt.dev/dumps/
- File naming: `polymarket_orderbook_2026-02-27T15.parquet`
- Free access, no API key required
- Faster downloads via Discord/Telegram (mentioned on site)

---

## Use Cases for NanoClaw Trading System

### 1. Prove Edge Before Live Trading

Per Luckshury's advice: "Most assume it's their account size which is holding them back from success when in reality they have zero or little concrete evidence that they have an edge in the first place."

**With this data**, you can:
- Backtest probability estimation on hundreds of RESOLVED markets
- Measure actual edge (true_prob - market_prob) vs realized outcomes
- Track drawdown frequency and depth across market conditions
- Validate Kelly Criterion sizing produces better returns than fixed sizing

###2. Build Statistical Playbook

Per "Size based on math not gut feeling":
- Identify which event types your probability estimation performs best on
- Document conditions where edge is strongest
- Calculate optimal Kelly fraction by market type
- Build confidence multipliers based on historical accuracy

### 3. Test Strategy Parameters

Optimize currently mock parameters:
- `min_edge` (currently 0.10) - test 0.05, 0.10, 0.15, 0.20
- `min_confidence` (currently 0.70) - test 0.60, 0.70, 0.80
- `kelly_fraction` (currently 0.5) - test full Kelly vs half Kelly vs quarter Kelly
- Event type filters - economic vs political vs crypto performance

### 4. Validate Probability Models

Test existing models against reality:
- **Fed rate decisions**: Does inflation data + Fed statements predict outcomes?
- **Bitcoin targets**: Does required gain / volatility / time horizon model work?
- **Political events**: Do poll aggregates + historical error work?

---

## Integration with Existing System

NanoClaw already has infrastructure for this:

### Database Tables (already exist)
```sql
CREATE TABLE market_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  price REAL NOT NULL,
  volume REAL,
  open_interest REAL,
  metadata TEXT
);

CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  initial_capital REAL NOT NULL,
  final_capital REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  winning_trades INTEGER NOT NULL,
  max_drawdown REAL NOT NULL,
  sharpe_ratio REAL NOT NULL,
  parameters TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### Market Watcher (lines 27-113 in monitor-server.ts)
- Already fetches real-time Polymarket prices via CLOB API
- Stores to `market_data` table
- Can be adapted to import historical data

### Strategy Optimizer (lines 115-209 in monitor-server.ts)
- Already has backtest engine with RSI strategy
- Can be extended for probability-based strategies
- Calculates P&L, win rate, drawdown, Sharpe ratio

### Dashboard (enhanced-dashboard.html)
- Trading tab ready to display backtest results
- Performance metrics visualization
- Signals tracking

---

## Implementation Plan

### Phase 1: Data Import (1-2 hours)
1. Install Parquet reader (Python pandas or Node parquetjs)
2. Download 1 week of historical data (~100-200 files)
3. Parse schema to understand fields
4. Write import script to load into `market_data` table
5. Filter for resolved markets only

### Phase 2: Backtest Framework (2-3 hours)
1. Identify resolved markets in historical data
2. For each market:
   - Extract price history leading to resolution
   - Run `analyze-event-probability` tool to estimate true_prob
   - Compare estimate vs final market price vs actual outcome
   - Calculate edge, P&L if traded
3. Aggregate results across all markets

### Phase 3: Edge Validation (1 hour)
1. Calculate metrics:
   - Overall accuracy (what % of probability estimates were correct)
   - Average edge captured
   - Drawdown frequency/depth
   - Performance by event type
   - Kelly sizing vs fixed sizing returns
2. Document findings in memory

### Phase 4: Parameter Optimization (1-2 hours)
1. Test different `min_edge` thresholds
2. Test different confidence levels
3. Test different Kelly fractions
4. Identify optimal configuration

---

## Next Steps

1. **Contact pmxt.dev** via Discord/Telegram for:
   - Data schema documentation
   - Which fields indicate resolved markets
   - Recommendations for backtesting setup

2. **Install proper Parquet reader**:
   - Try Python with pandas/pyarrow (more robust)
   - OR fix parquetjs Node integration
   - OR use DuckDB (SQL interface to Parquet)

3. **Download systematic dataset**:
   - Not just 1 file, but 1-2 weeks (100-200 files)
   - Focus on resolved markets for validation

4. **Build import pipeline**:
   - Script to bulk download files
   - Parse and load into SQLite `market_data`
   - Create index on (symbol, timestamp)

---

## Critical Insight

This data source enables **exactly** what Luckshury recommends:

> "It will take you YEARS of refinement and adjustment before you know whether your system has any legs to it, know what is variance vs what is you messing up will be an extremely challenging job."

With historical resolved markets, you can compress years of learning into days/weeks of backtesting.

**Before going live**: Prove edge on 100+ resolved markets first.

---

## Related Notes

- [[Prove edge before scaling capital not account size]]
- [[Size based on math not gut feeling for exponential growth]]
- [[Prediction markets require probability-based strategies not stock strategies]]
- [[Judge systems by distributions not individual outcomes]]

---

*Processed: 2026-02-27*
