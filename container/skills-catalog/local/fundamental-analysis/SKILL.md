---
name: fundamental-analysis
description: Compute Piotroski F-Score, PEG Ratio, Graham Number, and ROIC quality for stocks. Blend with technical analysis into a single 0-100 conviction score. Use when you need to evaluate a stock's financial health, intrinsic value, or want a combined fundamental+technical signal.
---

# Fundamental Analysis Skill

Quantitative fundamental screening using research-backed frameworks. Works alongside the `technical-analysis` skill.

## Scripts

```bash
FUND_ANALYSIS="$(dirname "$0")/fundamental_analysis.py"
# Or absolute: /skills-catalog/local/fundamental-analysis/fundamental_analysis.py

BLENDED="$(dirname "$0")/blended_score.py"
# Or absolute: /skills-catalog/local/fundamental-analysis/blended_score.py
```

## Setup

**Install dependencies (first time):**
```bash
pip install yfinance --quiet
```

No API keys required — uses Yahoo Finance via yfinance.

## Fundamental Analysis

```bash
# Full analysis (Piotroski + PEG + Graham + ROIC) → composite score 0-100
python3 "$FUND_ANALYSIS" analyze AAPL

# Individual components
python3 "$FUND_ANALYSIS" fscore AAPL      # Piotroski F-Score (0-9)
python3 "$FUND_ANALYSIS" peg AAPL         # PEG ratio + Lynch-adjusted PEG
python3 "$FUND_ANALYSIS" graham AAPL      # Graham Number + margin of safety %
python3 "$FUND_ANALYSIS" quality AAPL     # ROIC, ROE, margins, FCF quality

# Batch — returns ranked list by fundamental_score desc
python3 "$FUND_ANALYSIS" batch AAPL MSFT GOOGL NVDA
```

## Blended Score (Fundamental + Technical)

```bash
# Single ticker — full blended analysis (0-100)
python3 "$BLENDED" blend AAPL

# Batch — ranked by blended_score
python3 "$BLENDED" batch AAPL MSFT GOOGL NVDA META AMZN
```

**Depends on:** `technical-analysis` skill must be present in the same skills-catalog/local directory.

## Output: Fundamental Analysis

```json
{
  "ticker": "AAPL",
  "fundamental_score": 72,
  "overall": "bullish",
  "piotroski": {
    "score": 7,
    "signal": "average",
    "breakdown": {
      "net_income_positive": 1, "ocf_positive": 1, "roa_improving": 1,
      "ocf_beats_net_income": 1, "leverage_decreasing": 1,
      "current_ratio_improving": 0, "no_dilution": 1,
      "gross_margin_improving": 1, "asset_turnover_improving": 0
    }
  },
  "peg": { "pe": 28.4, "growth_pct": 12.5, "peg": 2.27, "signal": "bearish" },
  "graham": {
    "graham_number": 142.30,
    "current_price": 213.42,
    "margin_of_safety_pct": -50.0,
    "signal": "bearish"
  },
  "quality": {
    "roic_pct": 28.4, "roe_pct": 147.0,
    "gross_margin_pct": 46.2, "fcf_beats_net_income": true,
    "signal": "excellent"
  }
}
```

## Output: Blended Score

```json
{
  "ticker": "MSFT",
  "blended_score": 78,
  "signal": "strong_buy",
  "action": "High-conviction entry — strong fundamentals + favorable technicals",
  "setup_note": "IDEAL SETUP: Fundamentally strong (score 68) + technically oversold (RSI 28)",
  "breakdown": {
    "fundamental": { "score_contribution": 41, "max": 60, "raw_score": 68, "piotroski": 6, "peg": 0.39 },
    "technical":   { "score_contribution": 37, "max": 40, "rsi": 28.4, "macd_signal": "bearish" }
  }
}
```

## Signal Thresholds (Blended)

| Score | Signal | Meaning |
|-------|--------|---------|
| 80–100 | strong_buy | High conviction — both legs aligned |
| 65–79  | buy | Good setup |
| 45–64  | hold_watch | Watch for improvement |
| 30–44  | neutral | Mixed signals |
| 0–29   | avoid | Poor setup |

## The Blend Strategy

**Ideal entry:** Fundamentally strong (score ≥ 55) + technically oversold (RSI < 35)

This avoids:
- **Value traps** — cheap but deteriorating (low F-Score)
- **False breakouts** — good TA, weak business
- **Overbought quality** — great company, wrong price

## Scoring Weights

| Component | Weight | Basis |
|-----------|--------|-------|
| Piotroski F-Score | 35% | Financial health, distress risk |
| PEG Ratio | 25% | Growth-adjusted valuation (Lynch) |
| Graham Number | 20% | Margin of safety (Graham) |
| ROIC / Quality | 20% | Capital efficiency (Buffett/Greenblatt) |
| **Total Fundamental** | **60%** | What to buy |
| Technical (RSI/MACD/EMA/BB) | 40% | When to buy |
