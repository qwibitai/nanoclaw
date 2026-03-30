---
name: backtest
description: Backtest stock selection strategies against historical OHLCV data. Computes Sharpe ratio, CAGR, max drawdown, and win rate. Compares strategy vs SPY benchmark. Plots equity curves. Depends on market-data skill (yfinance). No API key required for historical data.
---

# Backtest Skill

Validate trading strategies against historical data before going live. Uses pandas-native math — no external backtest framework required beyond `yfinance` (auto-installed on first run, ~15s cold start).

## Usage

```bash
BACKTEST="$(dirname "$0")/backtest.py"
# Or: BACKTEST="/skills-catalog/local/backtest/backtest.py"
```

### Run a strategy backtest
```bash
python3 "$BACKTEST" run --tickers AAPL MSFT GOOGL NVDA --strategy momentum --years 2
```

Returns JSON with metrics (Sharpe, CAGR, drawdown, win rate), SPY benchmark comparison, and full equity curve data points.

### Compare all strategies head-to-head
```bash
python3 "$BACKTEST" compare --tickers AAPL MSFT GOOGL NVDA --years 3
```

Returns a side-by-side metrics table for `momentum`, `mean_reversion`, and `buy_hold`, plus SPY benchmark.

### Generate equity curve chart (PNG)
```bash
python3 "$BACKTEST" chart --tickers AAPL MSFT GOOGL NVDA --strategy momentum --years 2 --out /workspace/group/equity.png
```

Auto-installs `matplotlib` on first use (~10s). Returns JSON with `chart_path` pointing to the saved PNG.

## Strategies

| Strategy | Description |
|---|---|
| `buy_hold` | Equal-weight all tickers, never rebalance — passive baseline |
| `momentum` | Each rebalance period: go long top-50% tickers by N-day return |
| `mean_reversion` | Each rebalance period: go long bottom-50% tickers (contrarian bet) |

## Parameters

| Flag | Default | Description |
|---|---|---|
| `--tickers` | required | Space-separated ticker list (e.g. `AAPL MSFT GOOGL`) |
| `--years` | `2.0` | Lookback window in years |
| `--strategy` | `momentum` | `momentum`, `mean_reversion`, or `buy_hold` |
| `--lookback` | `20` | Days used for momentum/reversion signal |
| `--rebalance` | `monthly` | `daily`, `weekly`, or `monthly` |
| `--out` | `equity_curve.png` | Output path for chart PNG (`chart` command only) |

## Output format

```json
// run command
{
  "strategy": "momentum",
  "tickers": ["AAPL", "MSFT", "GOOGL"],
  "lookback_days": 20,
  "rebalance": "monthly",
  "metrics": {
    "total_return_pct": 48.3,
    "cagr_pct": 22.1,
    "sharpe": 1.42,
    "max_drawdown_pct": 18.7,
    "win_rate_pct": 54.2,
    "volatility_pct": 15.6,
    "trading_days": 502,
    "years": 2.0,
    "start_date": "2023-03-29",
    "end_date": "2025-03-28"
  },
  "benchmark": {
    "spy": { "cagr_pct": 18.4, "sharpe": 1.21, ... }
  },
  "equity_curve": [
    { "date": "2023-03-29", "value": 1.0 },
    ...
  ]
}
```

```json
// compare command
{
  "tickers": ["AAPL", "MSFT", "GOOGL"],
  "years": 2.0,
  "comparison": {
    "buy_hold": { "cagr_pct": 20.1, "sharpe": 1.35, ... },
    "momentum":  { "cagr_pct": 22.1, "sharpe": 1.42, ... },
    "mean_reversion": { "cagr_pct": 12.4, "sharpe": 0.89, ... },
    "SPY_benchmark": { "cagr_pct": 18.4, "sharpe": 1.21, ... }
  }
}
```

## Notes

- Transaction costs: 0.1% per unit of portfolio turnover (conservative estimate)
- SPY is always fetched as benchmark and excluded from the strategy universe
- Insufficient data for a ticker silently drops it (no crash)
- All returns assume long-only, equal-weight allocation within selected stocks
- Depends on `market-data` skill (sibling directory): `../market-data/market_data.py`
