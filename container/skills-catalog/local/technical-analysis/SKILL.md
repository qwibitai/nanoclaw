---
name: technical-analysis
description: Compute RSI, MACD, Bollinger Bands, EMA, and ATR for any stock ticker and return a signal summary. Use when you need technical indicators or want to know if a stock is overbought/oversold, trending, or showing bullish/bearish signals.
---

# Technical Analysis Skill

Computes technical indicators from OHLCV data and returns actionable signals.

## Setup

**Depends on:** `market-data` skill (yfinance, no API key required for historical data)

**Install dependencies (first time):**
```bash
pip install pandas pandas-ta --quiet
# yfinance is already required by market-data skill
```

## Usage

```bash
TECH_ANALYSIS="$(dirname "$0")/technical_analysis.py"
# Or: TECH_ANALYSIS="/skills-catalog/local/technical-analysis/technical_analysis.py"
```

### Full analysis (all indicators)
```bash
python3 "$TECH_ANALYSIS" analyze AAPL
python3 "$TECH_ANALYSIS" analyze AAPL --days 200
```

### Individual indicators
```bash
python3 "$TECH_ANALYSIS" rsi AAPL
python3 "$TECH_ANALYSIS" macd AAPL
python3 "$TECH_ANALYSIS" bollinger AAPL
python3 "$TECH_ANALYSIS" ema AAPL
python3 "$TECH_ANALYSIS" atr AAPL
```

### Batch analysis (multiple tickers)
```bash
python3 "$TECH_ANALYSIS" batch AAPL MSFT NVDA GOOGL
```

## Output format

```json
// analyze — full summary
{
  "ticker": "AAPL",
  "price": 213.42,
  "as_of": "2026-03-21",
  "signals": {
    "rsi": {"value": 58.2, "signal": "neutral", "note": "RSI 58 — neither overbought nor oversold"},
    "macd": {"value": 2.14, "signal_line": 1.87, "histogram": 0.27, "signal": "bullish", "note": "MACD crossed above signal line"},
    "bollinger": {"upper": 220.5, "middle": 210.2, "lower": 199.8, "signal": "neutral", "note": "Price within bands"},
    "ema": {"ema20": 211.3, "ema50": 205.8, "ema200": 192.4, "signal": "bullish", "note": "Price above all EMAs, EMA20 > EMA50 > EMA200"},
    "atr": {"value": 4.21, "pct_of_price": 1.97, "signal": "neutral", "note": "ATR 4.21 (~1.97% of price)"}
  },
  "overall": "bullish",
  "bullish_count": 3,
  "bearish_count": 0,
  "neutral_count": 2
}
```

## Signal definitions

| Indicator | Bullish | Bearish | Neutral |
|-----------|---------|---------|---------|
| RSI | < 30 (oversold bounce) | > 70 (overbought) | 30–70 |
| MACD | MACD > signal, histogram positive | MACD < signal, histogram negative | Near crossover |
| Bollinger | Price near lower band | Price near upper band | Price within mid zone |
| EMA | Price > EMA200, EMA20 > EMA50 | Price < EMA200 | Mixed |
| ATR | — | — | Volatility context only |
