---
name: market-data
description: Fetch real-time quotes, historical OHLCV, and fundamental metrics for stocks. Use when you need current prices, price history, or financial ratios for any ticker. Foundation skill for all stock analysis tasks.
---

# Market Data Skill

Unified interface for stock market data. Wraps Alpaca (real-time), Finnhub (quotes + fundamentals), and yfinance (historical OHLCV).

## Setup — Required env vars

```bash
FINNHUB_API_KEY=<key>          # Free at finnhub.io — 60 calls/min
ALPACA_API_KEY=<key>           # Free at alpaca.markets
ALPACA_SECRET_KEY=<secret>
```

**Install dependencies (first time):**
```bash
pip install yfinance --quiet
```

## Usage

```bash
MARKET_DATA="$(dirname "$0")/market_data.py"
# Or: MARKET_DATA="/skills-catalog/local/market-data/market_data.py"
```

### Real-time quote
```bash
python3 "$MARKET_DATA" quote AAPL
# Returns: price, open, high, low, prev_close, change_pct
```

### Historical OHLCV
```bash
python3 "$MARKET_DATA" history AAPL --days 90
# Returns: daily OHLCV records array, 52-week high/low, market_cap
```

### Fundamental metrics
```bash
python3 "$MARKET_DATA" fundamentals AAPL
# Returns: P/E TTM, EPS, revenue growth, margins, debt/equity, ROE
# Requires FINNHUB_API_KEY
```

### Batch quotes
```bash
python3 "$MARKET_DATA" batch AAPL MSFT GOOGL NVDA
# Returns: array of quotes, falls back to yfinance if Finnhub unavailable
```

## Output format

All commands return JSON. Check for `"error"` key before using results.

```json
// quote
{"ticker": "AAPL", "price": 213.42, "change_pct": 1.09, "source": "finnhub"}

// history (abbreviated)
{"ticker": "AAPL", "days": 90, "records": [{"date": "2026-01-02", "open": 185.0, "close": 186.8, "volume": 54200000}], "week_52_high": 237.23}

// fundamentals
{"ticker": "AAPL", "pe_ttm": 28.4, "gross_margin_ttm": 0.457, "debt_equity": 1.87}
```

## Rate limits

| Source   | Free tier       |
|----------|-----------------|
| Finnhub  | 60 calls/min    |
| Alpaca   | No limit (US stocks) |
| yfinance | ~2 req/s recommended |
