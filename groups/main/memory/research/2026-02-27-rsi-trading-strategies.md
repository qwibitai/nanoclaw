# Article: 3 RSI Patterns With Rules, Backtest, And Examples

**Source**: https://x.com/quantifiedstrat/status/2026661968950567334
**Author**: QuantifiedStrategies.com (@QuantifiedStrat)
**Date**: February 2026
**Read**: February 27, 2026

## Summary

Three RSI (Relative Strength Index) trading strategies with backtested rules and performance metrics. Covers mean reversion (oversold bounce), smarter exits (momentum confirmation), and momentum trading (bull range + bull momentum). All strategies tested on SPY (S&P 500 ETF) from 1993-2026.

Key insight: Combining RSI with exit timing and momentum filters improves risk-adjusted returns significantly over basic RSI mean reversion.

## The 3 Strategies

### Strategy 1: Basic RSI Mean Reversion

**Rules**:
- Buy when 2-day RSI crosses below 10 (oversold)
- Sell when 2-day RSI crosses above 80 (overbought)

**Backtest Results** (SPY, 1993-2026):
- CAGR: ~9% annually
- Time invested: 27% (only in market 27% of the time)
- $100k → $1.7M over 33 years
- Max drawdown: -33.82%
- Win rate: 78.51% (263 winners, 72 losers)

**Drawdowns**: Significant drawdowns, longer losses, higher stress

### Strategy 2: Smarter Exit (QS Exit)

**Rules**:
- Buy when 2-day RSI crosses below 10 (same entry)
- **Sell when close is higher than yesterday's high** (momentum confirmation exit)

**Why better**: Rides momentum instead of waiting for RSI 80. Catches larger moves.

**Backtest Results**:
- CAGR: Similar to strategy 1
- **Max drawdown: -23.73%** (vs -33.82%)
- **Better drawdown profile**: Losses smaller and shorter
- **Better recovery factor**: 7.91 vs 4.94
- Less stress, smoother equity curve, better risk-adjusted performance

**Key improvement**: "On the right side, the losses are both smaller and shorter, resulting in a better recovery factor, exactly what you are looking for in a trading strategy."

### Strategy 3: RSI Momentum (Not Mean Reversion)

**Paradigm shift**: Instead of buying oversold, buy when RSI shows strong momentum.

**Indicators needed**:
1. **RSI bull range**: RSI fluctuates between 40-100 over N days (100-day lookback recommended)
2. **RSI bull momentum**: Highest high value of RSI > 70 over N days (14-day RSI recommended)

**Rules**:
- Buy SPY when RSI bull range AND bull momentum are both true
- Sell when either condition becomes false

**Why it works**: Momentum trading, not mean reversion. Catches strong uptrends.

**Backtest Results**: (Details not fully shown in captured screenshots, but article implies strong performance with momentum approach)

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **RSI < 10 identifies oversold conditions reliably**
   - 2-day RSI crossing below 10 = strong oversold signal
   - 78.51% win rate on SPY over 33 years
   - Works because extreme fear creates buying opportunity

2. **Exit strategy matters more than entry**
   - Same entry (RSI < 10)
   - Different exit (momentum vs overbought)
   - Result: 10% reduction in max drawdown, better recovery factor
   - "Close higher than yesterday's high" captures momentum rides

3. **RSI can be used for momentum, not just mean reversion**
   - RSI bull range (40-100) + RSI bull momentum (highest > 70)
   - Completely different paradigm from oversold/overbought
   - Regime trading: only trade when market showing strength

### Tier 2: Strategic Value 📋

1. **Time in market vs. returns**
   - Strategy 1: 27% time invested for 9% CAGR
   - Low time in market = capital efficiency
   - Can combine with other strategies

2. **Recovery factor as key metric**
   - Strategy 1: 4.94
   - Strategy 2: 7.91 (60% improvement!)
   - Measures how well strategy recovers from drawdowns
   - More important than absolute returns for psychology

3. **Drawdown comparison reveals quality**
   - Strategy 1: Longer, deeper drawdowns
   - Strategy 2: Shorter, shallower drawdowns
   - Visual comparison shows strategy 2 clearly superior for risk management

### Tier 3: Reference Knowledge 📚

**RSI Calculation**:
- Measures recent price changes to evaluate overbought/oversold
- Scale 0-100
- Traditional: <30 oversold, >70 overbought
- These strategies use more extreme levels (10 and 80)

**Backtest Parameters**:
- Asset: SPY (S&P 500 ETF)
- Period: 1993-2026 (33 years)
- Entries/exits: At close
- Initial capital: $100,000

**Performance Metrics Explained**:
- CAGR: Compound Annual Growth Rate
- Max Drawdown: Largest peak-to-trough decline
- Recovery Factor: Total profit / Max drawdown
- Win Rate: % of profitable trades
- Time Invested: % of days holding position

## Memory Notes Created

None - This is trading strategy reference material. Only applicable if building trading bots.

## Use Case

**IMPORTANT**: This article applies ONLY to:
- Building algorithmic trading systems
- Developing RSI-based trading strategies
- Backtesting momentum vs mean reversion approaches
- Trading bots for stock/ETF markets

**NOT applicable to**:
- Software development
- Agent orchestration
- General system design

## Applications to Trading Bot Development (if we build one)

### High Priority

**1. Implement RSI calculation**
- 2-day RSI for mean reversion
- 14-day RSI for momentum
- Bull range detection (40-100 over N days)
- Bull momentum detection (highest > 70)

**2. Exit strategy logic**
- Basic: Exit when RSI > 80
- Advanced: Exit when close > yesterday's high
- Track which performs better in live trading

**3. Backtest framework**
- Test on SPY data (1993-present)
- Calculate: CAGR, max drawdown, recovery factor, win rate
- Compare multiple exit strategies

### Medium Priority

**4. Risk management based on drawdown**
- Monitor current drawdown
- Reduce position size during drawdowns
- Strategy 2's better recovery factor suggests it's more tradeable

**5. Regime detection**
- Implement bull range and bull momentum filters
- Only trade momentum when both conditions true
- Avoid mean reversion in strong trends

### Low Priority

**6. Parameter optimization**
- Test different RSI periods (2-day, 14-day, etc.)
- Test different thresholds (10 vs 5, 80 vs 85)
- Optimize lookback periods for bull range/momentum

## Implementation Metrics

- **Memory notes created**: 0 (trading-specific reference)
- **Strategies covered**: 3 (mean reversion, smarter exit, momentum)
- **Backtest period**: 33 years (1993-2026)
- **Win rate**: 78.51% (strategy 1)
- **Max drawdown improvement**: 10% (strategy 2 vs 1)

## Key Quotes

"$100,000 grows to almost $1.7 million over 33 years, roughly 9% annually, while being invested only 27% of the time."

"On the right side, the losses are both smaller and shorter, resulting in a better recovery factor, exactly what you are looking for in a trading strategy."

"This strategy shifts from mean reversion to regime trading (momentum)."

## Pattern: RSI Mean Reversion with Smart Exit

```
Market shows extreme fear (RSI < 10)
    ↓
Enter long position
    ↓
Monitor for momentum confirmation
    ↓
Exit when close > yesterday's high
    ↓
Captures bounce + early momentum
    ↓
Result: Better risk-adjusted returns
```

## Related Research

- [[End-of-day trading reduces emotional interference in momentum strategies]] - Both use EOD entries/exits
- [[Judge systems by distributions not individual outcomes]] - 78% win rate over 33 years
- [[Volatility contraction patterns signal momentum continuation setups]] - Momentum vs mean reversion

## Next Steps

**For Trading Bot** (if we build one):
1. Implement 2-day and 14-day RSI calculation
2. Code strategy 2 (RSI < 10 entry, close > yesterday's high exit)
3. Backtest on SPY data
4. Compare drawdown profiles
5. Add bull range and bull momentum filters for strategy 3

**Not Applicable to NanoClaw**:
- This is purely trading strategy
- No software development patterns
- No agent orchestration concepts

## Source

Tweet: https://x.com/quantifiedstrat/status/2026661968950567334
Website: QuantifiedStrategies.com
Author: QuantifiedStrategies.com (@QuantifiedStrat)
Type: Trading strategy with backtests and examples
Strategies: Mean reversion, smart exit, momentum
