---
description: Stock trading strategies (RSI, time stops, volatility sizing) fundamentally don't apply to prediction markets due to different price mechanics
topics: [trading, prediction-markets, nanoclaw]
created: 2026-02-27
---

# Prediction markets require probability-based strategies not stock strategies

## Core Insight

User correction: "You should separate your stock trading knowledge and policies from polymarket trading. They should be two separate applications of practice"

This was critical feedback after I initially applied stock trading strategies (RSI mean reversion, 5-day time stops, intraday scalping) to prediction market trading.

## Why Stock Strategies Fail for Prediction Markets

**Stocks:**
- Continuous pricing (can go to any value)
- No expiration/resolution date
- Value derived from company fundamentals
- Technical indicators measure momentum and mean reversion

**Prediction Markets:**
- Binary outcomes (0 or 1 at resolution)
- Fixed resolution date
- Price = implied probability of event
- Technical indicators are meaningless noise

## Correct Approach for Prediction Markets

### Entry Criteria
- ❌ RSI < 10 (oversold, expect bounce)
- ✅ Edge > 10 points (true_prob - market_prob)

### Position Sizing
- ❌ Base size × (1 - volatility)
- ✅ Kelly Criterion: f* = (p×b - q) / b

### Exit Criteria
- ❌ 5-day time stop OR profit target
- ✅ Thesis invalidated OR edge captured OR approaching resolution

### Core Logic
- Calculate true probability using Bayesian updating and domain knowledge
- Compare to market probability to find edge
- Size positions using Kelly Criterion based on edge and confidence
- Exit when new information invalidates thesis (not arbitrary time)

## Implementation

Created separate prediction market framework:
- `analyze-event-probability`: Estimate true probabilities
- `detect-news-catalyst`: Find information updates
- `assess-liquidity`: Validate market depth
- Updated agent prompts: probability-estimator, risk-manager
- Deprecated stock-based tools for PM context

## Related Notes

- [[PREDICTION_MARKETS_VS_STOCKS.md]] (detailed comparison)
- [[PREDICTION_MARKET_FRAMEWORK.md]] (correct analysis approach)

---
*Topics: [[trading]] · [[prediction-markets]] · [[nanoclaw]]*
