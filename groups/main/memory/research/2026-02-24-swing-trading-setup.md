# Article: Swing Trading Setup in 3 Steps (avg 100%+/y trading <30 min/day)

**Source**: https://x.com/felipeguirao/status/2025627584797581499
**Author**: Felipe Guirao (@FelipeGuirao)
**Date**: February 22, 2026
**Read**: February 24, 2026

## Summary

Felipe Guirao's momentum swing trading system: 3-step setup targeting volatility contraction patterns (VCP), entering in last 2 minutes of trading day. Results: 65% win rate, 80% profitable months, 13% max drawdown, average 100%+ returns/year, <30 min/day commitment.

Key insight: End-of-day entry eliminates emotional interference and intraday noise. Systems-based approach with rules-first (95% hard rules, 5% discretion). Understanding distribution prevents abandoning working systems during normal losing streaks.

## Key Learnings

### Tier 1: Immediately Applicable ✅

1. **End-of-day trading eliminates emotional interference**
   - Created: [[End-of-day trading reduces emotional interference in momentum strategies]]
   - Enter trades in last 2 minutes of day (3:58pm EST)
   - Can't react emotionally to intraday moves
   - Trading <30 min/day, 98% of time free
   - 65% win rate with low drawdown

2. **Volatility Contraction Pattern (VCP) signals continuation**
   - Created: [[Volatility contraction patterns signal momentum continuation setups]]
   - First valid consolidation after breakout
   - Trendlines must converge (not expand)
   - Second leg of trend is strongest (highest probability)
   - Strict qualification criteria filters noise

3. **Understanding distribution prevents system abandonment**
   - 35% win rate system will have 10 losers in row statistically
   - Most traders abandon during normal losing streaks
   - Felipe's 65% win rate: 8 losers in row only every 2-3 years
   - Know your system's distribution upfront

### Tier 2: Strategic Value 📋

1. **Risk-first approach for capital preservation**
   - Not designed to take 50k to 5M
   - Designed for consistent 100%+ with low drawdown
   - Nobody with real capital wants 300%+ returns with 30%+ drawdowns
   - Time/mind freedom for job/business/family

2. **Systems trading principles FIRST (95% rules, 5% discretion)**
   - 7 years total experience, 2 years to fully develop system
   - Built durable edge based on DATA
   - Hard rule based (95%), minimal discretion (5% for setup prioritization)
   - Stock trading is not art, it's hard data and statistical distribution

3. **The 3-Step Setup Process**

   **Step 1**: Stock breaks out from multi-week/month base
   - Establishes first leg of new, fresh trend
   - Strong momentum behind it

   **Step 2**: Find first valid VCP
   - Consolidation at least 7 days from high before breakout
   - Volatility contraction (trendlines converge, not expand)
   - Must touch 8/20 EMA layer
   - No daily close below 20 EMA

   **Step 3**: Look for the breakout
   - Strong range expansion candle
   - Bigger and stronger than 2 preceding candles
   - No big wick on upper side
   - Closes above resistance (level or down trendline)
   - Enter at close before 4:00 pm EST

4. **Risk management rules**
   - Stop loss: Below LOD (Low Of Day)
   - Time stop: 5-day move (exit after 5 days if not working)
   - Move stop to BE after 1:1 RR level
   - Simple, effective, non-discretionary, scalable

### Tier 3: Reference Knowledge 📚

1. **Daily routine (all times NY EST)**
   - 3:30 pm: Open brokerage, TradingView, TC2000
   - 3:35 pm: Begin scanning for signals
     - 3 separate scans: bullish, short, ETFs
     - Mainly use TC2000 for stock scanning
   - 3:50 pm: Know valid signals, move to TradingView
     - Load stocks on brokerage
     - Close any trades on day 5 after entry
   - 3:58 pm: Enter trades just before close
     - Add stop loss (GTC)
     - Add BE alarm
   - Done in <30 min most of time

2. **System statistics**
   - Win rate: 65% (medium = low drawdown, low time in DD, few losers in row)
   - Profitable months: 80%
   - Max drawdown: 13%
   - Consecutive losers: 8 max (once every 2-3 years)
   - Average returns: 100%+/year
   - Time commitment: <30 min/day

3. **Momentum focus: Volatility contraction/expansion + momentum**
   - As momentum swing traders, care about:
     - Volatility contraction/expansion
     - Momentum
   - Pair these 2, understand how stocks move long and short
   - Foundation to build edge

4. **Distribution understanding is critical**
   - If 35% success rate, you WILL have 10 losers in row
   - Copying favorite trader without knowing distribution = danger
   - Get 9 losers, think "not working", abandon system
   - That's why most don't make it (don't understand distribution)

## Memory Notes Created

1. [[End-of-day trading reduces emotional interference in momentum strategies]]
2. [[Volatility contraction patterns signal momentum continuation setups]]

## Use Case

**IMPORTANT**: This article is specifically about swing trading momentum stocks in financial markets. The concepts apply to:
- Building trading bots for swing trading
- Developing momentum trading strategies
- End-of-day trading systems
- Risk-first capital growth strategies

**NOT applicable to**:
- Intraday trading strategies
- Software development processes
- General product development

## Applications to Trading Bot Development (if we build one)

### High Priority

**1. End-of-day execution system**
- Schedule trades for 3:58pm EST (last 2 min of market)
- Eliminates need for intraday monitoring
- Reduces API calls (one execution window per day)
- Pattern: Scan 3:30-3:50pm, execute 3:58pm

**2. VCP pattern detection**
- Algorithm to detect volatility contraction:
  - Measure trendline convergence (not divergence)
  - Check consolidation duration (≥7 days from high)
  - Validate 8/20 EMA touch
  - Confirm no close below 20 EMA
- Filter for first valid consolidation after base breakout

**3. Distribution-aware backtesting**
- Track consecutive losers distribution
- Calculate max drawdown scenarios
- Simulate losing streaks to verify psychological tolerance
- Report: "With 65% win rate, expect 8 losers in row every 2-3 years"

### Medium Priority

**4. Rule-based system (95% rules, 5% discretion)**
- Hard-code all qualification criteria
- Minimal discretionary parameters
- Document the 5% discretion areas (setup prioritization)
- Prevents emotional override of system

**5. Time-based risk management**
- Auto-exit after 5 days if not profitable
- Auto-move stop to BE at 1:1 RR
- GTC stop loss orders
- BE alarms for monitoring

**6. Scanning architecture**
- TC2000-style scans for bullish/short/ETF setups
- Filter stocks meeting all VCP criteria
- Prioritize by momentum strength
- Output: Final watchlist by 3:50pm

### Low Priority

**7. Performance tracking by distribution**
- Win rate by month
- Consecutive loser tracking
- Drawdown duration measurement
- Compare actual vs. expected distribution

## Implementation Metrics

- **Memory notes created**: 2
- **Win rate**: 65% (medium for low drawdown)
- **Max drawdown**: 13%
- **Time commitment**: <30 min/day
- **System basis**: Data-driven (95% rules, 5% discretion)

## Key Quotes

"My style of trading is based on systems trading principles FIRST."

"Stock trading is not an art, but hard data and statistical distribution."

"I trade end-of-day. This means I wait literally to the last 2 min of the trading day to enter."

"Paired with all my rules, this gives me a huge edge (contrary to popular belief this is 'wrong' or being 'late', for example)."

"Most people trading don't understand the distribution of what they are trading, and what that means practically in the day-to-day execution."

"If you have a 35% success rate trading style, whatever it is, by statistical distribution you will have 10 losers in a row."

"That's why most don't make it in this game to begin with, they don't understand stock trading is not an art, but hard data and statistical distribution."

## Pattern: 3-Step Momentum Setup

```
Stock breaks out from base (multi-week/month)
    ↓
First leg of trend established
    ↓
Consolidation forms (7+ days from high)
    ↓
Volatility contracts (VCP qualification)
    ↓
Breakout from VCP
    ↓
Enter at 3:58pm EST (last 2 min)
    ↓
Stop below LOD, exit day 5 if not working
    ↓
Move stop to BE at 1:1 RR
```

## VCP Qualification Checklist

- [ ] Consolidation at least 7 days from high before breakout
- [ ] Volatility contraction (trendlines converge, not expand)
- [ ] Consolidation touches 8/20 EMA layer
- [ ] No daily close below 20 EMA
- [ ] Strong range expansion breakout candle
- [ ] Bigger/stronger than 2 preceding candles
- [ ] No big wick on upper side
- [ ] Closes above resistance (level or trendline)

## Related Research

- [[Judge systems by distributions not individual outcomes]] - Understanding expected losing streaks
- [[Pre-accepting failure rates enables rational decision making]] - Know drawdowns upfront
- [[Multi-agent LLM systems outperform single agents in trading]] - If building multi-agent trading bot

## Next Steps

**For Trading Bot Development** (if we build one):
1. Implement VCP pattern detection algorithm
2. Build end-of-day execution scheduler (3:58pm EST)
3. Create distribution-aware backtesting
4. Track consecutive losers and drawdown stats
5. Code hard rules (95%) with minimal discretion points (5%)

**Not Applicable to NanoClaw** (software development system):
- This is purely trading strategy
- Does not apply to agent orchestration
- Does not apply to software quality
- Relevant only if building trading bot

## Source

Tweet: https://x.com/felipeguirao/status/2025627584797581499
Author: Felipe Guirao (@FelipeGuirao)
Strategy: End-of-day momentum swing trading with VCP patterns
Results: 65% win rate, 80% profitable months, 13% max DD, avg 100%+/y
Time: <30 min/day commitment
