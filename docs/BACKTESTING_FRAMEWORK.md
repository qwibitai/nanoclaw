# Backtesting Framework

Comprehensive backtesting system for prediction market trading strategies using historical pmxt.dev data.

## Overview

The backtesting framework consists of three complementary approaches:

1. **Basic Backtesting** (`backtest-engine.js`) - Test strategies on historical data
2. **Walk-Forward Optimization** (`walk-forward-optimization.js`) - Prevent overfitting with train/test splits
3. **Monte Carlo Simulation** (`monte-carlo-backtest.js`) - Test robustness via randomization

## Why Multiple Approaches?

### Basic Backtesting
- **Purpose**: Quick validation of strategy logic
- **Risk**: May overfit to specific sequence of events
- **Use when**: Initial strategy development

### Walk-Forward Optimization
- **Purpose**: Prevent look-ahead bias and overfitting
- **Method**: Train on period 1, test on period 2, repeat
- **Use when**: Optimizing strategy parameters

### Monte Carlo Simulation
- **Purpose**: Understand distribution of possible outcomes
- **Method**: Randomize trade sequence 1000+ times
- **Use when**: Assessing strategy robustness before live trading

## Basic Backtesting

### Usage

```bash
node scripts/backtest-engine.js \
  --strategy probability-based \
  --start-date 2026-01-01 \
  --end-date 2026-01-31 \
  --initial-capital 10000 \
  --markets all \
  --transaction-cost 0.0020 \
  --slippage-bps 5 \
  --kelly-fraction 0.5
```

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--strategy` | `probability-based` | Strategy to test (probability-based \| market-making \| hft-signals) |
| `--start-date` | `2026-01-01` | Start date (ISO format) |
| `--end-date` | `2026-01-31` | End date (ISO format) |
| `--initial-capital` | `10000` | Starting capital in USD |
| `--markets` | `all` | Markets to test (all \| comma-separated token IDs) |
| `--transaction-cost` | `0.0020` | Transaction cost as decimal (0.2%) |
| `--slippage-bps` | `5` | Slippage in basis points |
| `--kelly-fraction` | `0.5` | Fraction of Kelly to use (0.5 = half Kelly) |
| `--output` | `backtest-results.json` | Output file path |

### Supported Strategies

#### 1. Probability-Based
Estimates true probability and compares to market price.

**Entry criteria**:
- Edge > 10 percentage points (true_prob - market_prob)
- Position size via Kelly Criterion

**Exit criteria**:
- Market resolves
- Thesis invalidated (not implemented in basic version)

#### 2. Market-Making
Posts bid/ask quotes to capture spread.

**Entry criteria**:
- Spread > 50 basis points
- Post quotes inside current best bid/ask

**Exit criteria**:
- Fills on both sides (inventory neutral)

#### 3. HFT Signals
Trades on orderbook microstructure.

**Entry criteria**:
- Price momentum > 0.5%
- Spread compression > 30%
- Volume spike > 1.5x average

**Exit criteria**:
- Quick scalps (not implemented in basic version)

### Output

```json
{
  "strategy": "probability-based",
  "date_range": {
    "start": "2026-01-01",
    "end": "2026-01-31"
  },
  "markets_tested": 47,
  "total_pnl": 1247.32,
  "avg_return_pct": 12.47,
  "avg_win_rate": 0.64,
  "avg_sharpe_ratio": 1.85,
  "max_drawdown": 0.08,
  "results": [...]
}
```

## Walk-Forward Optimization

Prevents overfitting by training on one period and testing on the next.

### Usage

```bash
node scripts/walk-forward-optimization.js \
  --strategy probability-based \
  --start-date 2025-01-01 \
  --end-date 2026-01-31 \
  --train-days 30 \
  --test-days 10
```

### How It Works

```
Time:  [---- Train 30d ----][-- Test 10d --][---- Train 30d ----][-- Test 10d --]
       ^                    ^               ^                    ^
       Optimize params      Test params     Optimize new params  Test new params
       on this period       on this period  on this period       on this period
```

### Parameter Grid

Each strategy has a parameter grid that's optimized:

**Probability-based**:
- `min_edge`: [0.05, 0.10, 0.15, 0.20]
- `kelly_fraction`: [0.25, 0.5, 0.75]
- `max_position_size`: [0.05, 0.10, 0.15]

**Market-making**:
- `risk_aversion`: [0.05, 0.1, 0.15]
- `quote_size`: [0.01, 0.02, 0.05]
- `min_spread_bps`: [30, 50, 100]

**HFT signals**:
- `min_momentum`: [0.003, 0.005, 0.01]
- `min_confidence`: [0.5, 0.6, 0.7]
- `position_size`: [0.03, 0.05, 0.10]

### Output

```json
{
  "strategy": "probability-based",
  "total_windows": 12,
  "successful_windows": 11,
  "out_of_sample_results": {
    "avg_return_pct": 8.32,
    "avg_win_rate": 0.61,
    "avg_sharpe_ratio": 1.42,
    "max_drawdown": 0.12
  },
  "windows": [
    {
      "window": 1,
      "train_period": "2025-01-01 to 2025-01-31",
      "test_period": "2025-01-31 to 2025-02-10",
      "optimized_parameters": {
        "min_edge": 0.10,
        "kelly_fraction": 0.5,
        "max_position_size": 0.10
      },
      "test_results": {
        "avg_return_pct": 11.2,
        "avg_win_rate": 0.68,
        "avg_sharpe_ratio": 1.87,
        "max_drawdown": 0.09
      }
    }
  ]
}
```

## Monte Carlo Simulation

Tests strategy robustness by randomizing trade sequence.

### Usage

```bash
# First run a backtest
node scripts/backtest-engine.js --strategy probability-based --output my-backtest.json

# Then run Monte Carlo on the results
node scripts/monte-carlo-backtest.js \
  --backtest-file my-backtest.json \
  --runs 1000
```

### How It Works

1. Extract all trades from backtest (with P&L for each)
2. Randomize trade order 1000 times
3. Recalculate equity curve for each randomization
4. Analyze distribution of outcomes

### Why This Matters

Your backtest shows +15% return. But was this due to:
- **Robust strategy**: Would make money in most randomized sequences
- **Lucky timing**: Just happened to get profitable trades early

Monte Carlo reveals the truth:
- If 90% of randomized sequences are profitable → robust
- If only 40% are profitable → got lucky

### Output

```
=== Monte Carlo Results ===

Return Percentiles:
  5th percentile: -8.2%
  25th percentile: 3.1%
  50th percentile (median): 12.5%
  75th percentile: 21.3%
  95th percentile: 35.7%

Probability of profit: 82.4%

Average Statistics:
  Return: 12.47%
  Drawdown: 11.2%
  Sharpe: 1.64

Worst Case Scenario:
  Return: -22.3%
  Drawdown: 28.5%
  Sharpe: -0.42

Best Case Scenario:
  Return: 47.8%
  Drawdown: 5.2%
  Sharpe: 3.21

=== Interpretation ===
✅ ROBUST: >80% of randomized sequences are profitable
✅ GOOD DOWNSIDE: Even worst 5% lose less than 10%
```

## Recommended Workflow

### 1. Initial Development
```bash
# Quick test on 1 month of data
node scripts/backtest-engine.js \
  --strategy probability-based \
  --start-date 2026-01-01 \
  --end-date 2026-01-31
```

### 2. Parameter Optimization
```bash
# Walk-forward over 6 months
node scripts/walk-forward-optimization.js \
  --strategy probability-based \
  --start-date 2025-07-01 \
  --end-date 2026-01-31 \
  --train-days 30 \
  --test-days 10
```

### 3. Robustness Testing
```bash
# Run best strategy through Monte Carlo
node scripts/backtest-engine.js \
  --strategy probability-based \
  --start-date 2025-01-01 \
  --end-date 2026-01-31 \
  --output final-backtest.json

node scripts/monte-carlo-backtest.js \
  --backtest-file final-backtest.json \
  --runs 1000
```

### 4. Live Trading Decision

Only proceed to live trading if:
- [ ] Walk-forward out-of-sample return > 10% annually
- [ ] Walk-forward Sharpe ratio > 1.0
- [ ] Walk-forward max drawdown < 20%
- [ ] Monte Carlo profit probability > 75%
- [ ] Monte Carlo 5th percentile > -15%

## Common Pitfalls

### 1. Overfitting
**Problem**: Strategy optimized to specific historical sequence

**Solution**: Use walk-forward optimization, not single-period optimization

### 2. Look-Ahead Bias
**Problem**: Using information not available at trade time

**Solution**: Ensure all signals use only data available before trade execution

### 3. Survivorship Bias
**Problem**: Only testing on markets that resolved

**Solution**: Include all markets from time period, not cherry-picked ones

### 4. Data Snooping
**Problem**: Testing many strategies, only reporting best one

**Solution**: Pre-register strategy before backtesting, don't modify after seeing results

### 5. Transaction Costs
**Problem**: Ignoring costs makes strategy look profitable when it's not

**Solution**: Always include realistic transaction costs (0.2%) and slippage (5 bps)

## Performance Benchmarks

### Acceptable Performance (Paper Trading)
- Return: 10-20% annually
- Sharpe: 0.8-1.2
- Win rate: 55-65%
- Max drawdown: 15-25%

### Good Performance (Consider Live)
- Return: 20-40% annually
- Sharpe: 1.2-2.0
- Win rate: 60-70%
- Max drawdown: 10-20%

### Excellent Performance (Rare)
- Return: >40% annually
- Sharpe: >2.0
- Win rate: >70%
- Max drawdown: <10%

## Database Storage

All backtest results are stored in SQLite:

```sql
SELECT * FROM backtest_runs
ORDER BY created_at DESC
LIMIT 10;
```

Fields:
- `start_date`, `end_date`: Date range
- `strategy`: Strategy name
- `total_trades`: Number of trades
- `win_rate`: Percentage of winning trades
- `total_pnl`: Total profit/loss
- `max_drawdown`: Maximum drawdown
- `sharpe_ratio`: Sharpe ratio
- `notes`: JSON metadata
- `created_at`: Timestamp

## Next Steps

After successful backtesting:
1. Run 100+ paper trades in real-time (not backtested)
2. Compare paper trading results to backtest predictions
3. If paper trading matches backtests, consider small live trades (1% position sizes)
4. Scale up gradually as confidence builds

## Troubleshooting

### "No data files found"
- Ensure pmxt.dev data downloaded: `node scripts/download-pmxt-batch.js`
- Check `pmxt-data/` directory exists with `.parquet` files

### "Process killed (exit code 137)"
- Container out of memory
- DuckDB should handle this, but try shorter date ranges

### "No markets returned"
- Check `market_metadata` table: `sqlite3 store/messages.db "SELECT COUNT(*) FROM market_metadata;"`
- Run `node scripts/fetch-resolved-markets.js` to populate

### Backtest returns 0% on all markets
- Check transaction costs aren't too high
- Verify strategy parameters aren't too conservative
- Examine individual trade logs in output JSON
