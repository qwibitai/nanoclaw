# Example Trading Workflow

Step-by-step example of how a human or automated system would use the trading bot.

## Manual Execution (For Testing)

### Step 1: Scan Markets

```
@Andy, run trading__analyze_market with platform "all" and lookback_days 14
```

**Expected Response:**
```
Found 8 trading signals across 10 markets.

Top 5 opportunities:
1. FED-RATE-MARCH24 (kalshi): SELL @ 0.4500 - 85.0% confidence
   Strategy: rsi_mean_reversion
   Extreme oversold condition: RSI(2) = 7.23 < 10. Historical win rate: 78.5%.
   Exit when price > yesterday's high (0.4387)

2. BTC_100K_2024 (polymarket): BUY @ 0.4200 - 78.0% confidence
   Strategy: volatility_contraction
   Volatility Contraction Pattern detected. 7d vol: 0.0423, 14d vol: 0.0821,
   30d vol: 0.1203. Decreasing volatility signals potential breakout.

...
```

### Step 2: Review Top Signal

Now spawn specialist agents to analyze the top signal:

```
@Andy, analyze the FED-RATE-MARCH24 trade signal. Get input from:
1. Technical Analyst - validate RSI and entry/exit
2. Fundamental Analyst - assess rate cut probability
3. Sentiment Analyst - check news and market psychology
4. Bull Researcher - build case FOR the trade
5. Bear Researcher - build case AGAINST the trade
6. Risk Manager - make final go/no-go decision with position size
```

**Expected Flow:**

Each agent responds with their analysis. Example outputs:

**Technical Analyst:**
```
Symbol: FED-RATE-MARCH24
Technical Signal: CONFIRMED

RSI Analysis:
- 2-day RSI: 7.23 (extreme oversold)
- 14-day RSI: 31.2
- Historical win rate at this level: 78%

Entry Quality: EXCELLENT
Suggested Entry: 0.45 (current price)
Profit Target: 0.38 (-7% market move = +18% profit for us)
Stop Loss: 0.50 (+5% against us)

Confidence: 85%
```

**Fundamental Analyst:**
```
Symbol: FED-RATE-MARCH24
Fundamental Assessment: BEARISH on rate cut (bullish on our SELL position)

Fair Value Estimate: 0.25 (market at 0.45 = overpriced)

Key Factors:
- Inflation still 3.2% vs 2% target
- Last Fed statement signaled patience
- Strong employment data (no urgency)

Recommendation: BUY (we're selling, so this supports)
Reasoning: Market overpricing cut probability by ~20 points. Data doesn't support March cut.
```

**Bull Researcher (arguing FOR our SELL trade):**
```
Bull Case Strength: STRONG

Key Arguments:
1. Extreme RSI oversold = 78% historical win rate
2. Fundamental data (inflation) doesn't support March cut
3. Market overreacting to dovish headlines, ignoring data

Expected Value: $165 (78% × $300 gain - 22% × $375 loss)
Conviction: 80%
```

**Bear Researcher (arguing AGAINST our SELL trade):**
```
Bear Case Strength: WEAK

Key Concerns:
1. Fed could surprise (low probability but possible)
2. Timing risk - might be right but early
3. Market has more information than we do

Concerns: 30%
Summary: Valid concerns but weak. Fed surprises rare with current data. Edge is strong.
```

**Risk Manager:**
```
DECISION: GO (REDUCED SIZE)

Position Size: $750 (7.5% of $10K portfolio)
Risk Capital: $375 (5% stop loss)
Expected Value: $165 (22% return)

Risk Checks:
✓ Drawdown: -8% / 25% limit
✓ Confidence: 85% / 70% minimum
✓ Position Size: 7.5% / 10% limit (reduced due to volatility)
✓ Correlation: 10% / 30% limit
✓ Consecutive Losses: 2 / 8 threshold

Execution Details:
- Symbol: FED-RATE-MARCH24
- Action: SELL
- Size: $750
- Entry: 0.45
- Stop Loss: 0.50
- Profit Target: 0.38
- Time Stop: 5 days
```

### Step 3: Execute Trade

```
@Andy, execute the FED-RATE-MARCH24 trade using trading__place_trade:
- symbol: "FED-RATE-MARCH24"
- platform: "kalshi"
- action: "sell"
- mode: "paper"
- size: 750
- limit_price: 0.45
- confidence: 0.85
- volatility: 0.08
```

**Expected Response:**
```
PAPER TRADE: SELL 750 contracts of FED-RATE-MARCH24 @ 0.4500.
Order filled. Position 42 opened.

Trade logged to:
- trading_positions (ID: 42)
- trading_orders (ID: 87)
- /workspace/group/memory/trading/decisions/2024-02-27.jsonl
```

### Step 4: Monitor Position

Check position status:

```
@Andy, show me my open trading positions
```

**Expected Response:**
```
Open Positions (1):

#42: FED-RATE-MARCH24 (Kalshi)
Entry: 2024-02-27 @ 0.4500
Size: 750 contracts
Days Open: 0
Current P&L: $0 (0%)
Stop Loss: 0.50
Profit Target: 0.38
Time Stop: 5 days (exit by Mar 4)
```

### Step 5: Review Performance (After Some Trades)

```
@Andy, run trading__review_performance with period_days 30
```

**Expected Response:**
```
# Performance Review (30 days)

## Metrics
- Total P&L: $1,245.50
- Win Rate: 76.2% (16/21 trades) ← Target: 78%
- Max Drawdown: -12.3% ← Limit: -25%
- Sharpe Ratio: 1.42 ← Min: 0.5
- Avg Win: $127.30
- Avg Loss: -$95.20

## Insights
- ✅ Exceptional win rate close to target
- ✅ Drawdown well controlled
- ✅ Sharpe ratio excellent
- ⚠️ 4 consecutive losses (normal variance)

## Suggested Adjustments
- No adjustments needed - strategy performing as expected
- Continue current approach

## Next Steps
- Continue current strategy
- Monitor for degradation in next review
```

---

## Automated Execution (Scheduled Tasks)

### Daily Market Scan (3:50 PM EST)

**Task**: `trading-daily-scan`
**Schedule**: Cron `0 15 50 * * *` (3:50 PM daily)
**Prompt**:
```
Run trading__analyze_market with all platforms and default settings.

For each signal with confidence > 75%, create a summary and log to
/workspace/group/memory/trading/decisions/[TODAY].jsonl

Format:
{
  "timestamp": "[ISO-8601]",
  "symbol": "[SYMBOL]",
  "platform": "[platform]",
  "signal": "detected",
  "confidence": [0-1],
  "reasoning": "[brief]"
}

Reply with: "Scanned [N] markets, found [X] high-confidence signals."
```

### Daily Execution (3:58 PM EST)

**Task**: `trading-daily-execute`
**Schedule**: Cron `0 15 58 * * *` (3:58 PM daily)
**Prompt**:
```
Read today's signals from /workspace/group/memory/trading/decisions/[TODAY].jsonl

For each signal with confidence > 80%:
1. Spawn Technical Analyst to validate
2. Spawn Fundamental Analyst to assess probability
3. Spawn Sentiment Analyst to check news/social
4. Wait for all 3 to complete
5. Spawn Bull Researcher with summaries
6. Spawn Bear Researcher with summaries
7. Wait for both to complete
8. Spawn Risk Manager with all analyses
9. If Risk Manager says GO, execute via trading__place_trade in paper mode

Log all decisions to same JSONL file.

Reply with: "Executed [X] trades, passed on [Y] signals."
```

### Weekly Review (Sundays 10 AM)

**Task**: `trading-weekly-review`
**Schedule**: Cron `0 10 0 * * 0` (Sunday 10 AM)
**Prompt**:
```
Run trading__review_performance with period_days 7.

Review the output and:
1. If win rate < 60%, suggest prompt adjustments
2. If consecutive losses > 6, investigate what changed
3. If Sharpe < 0.5, recommend position size reduction
4. Update /workspace/group/memory/trading/README.md with latest stats

Reply with performance summary and any recommended actions.
```

---

## Example Multi-Day Scenario

**Day 1 (Feb 27):**
- 3:50 PM: Scan finds 3 signals
- 3:58 PM: Execute 1 trade (FED-RATE-MARCH24 @ 0.45)
- Position opens

**Day 2 (Feb 28):**
- Market moves to 0.42
- Paper P&L: +$225 (unrealized)
- Still holding (waiting for smart exit trigger)

**Day 3 (Mar 1):**
- Market spikes to 0.47 on news
- Price > yesterday's high (0.42) AND RSI > 10
- Smart exit triggered automatically
- Exit @ 0.47, Loss: -$150
- Log to trading_positions (status: closed, pnl: -150)

**Day 4 (Mar 2):**
- 3:50 PM: Scan finds new signal (BTC_100K_2024)
- 3:58 PM: Execute trade
- Position opens

**Sunday (Mar 3):**
- 10 AM: Weekly review runs
- 2 trades, 1 win, 1 loss, 50% win rate
- Review notes: "Sample size too small, continue trading"

**After 100+ Trades:**
- Review shows 78% win rate, -15% max drawdown, 1.2 Sharpe
- System recommends: "Ready for live trading graduation"
- User manually enables live mode after review

---

## Dashboard Monitoring

While trading is happening, monitor via:

```
http://localhost:9100

Click "Trading" tab to see:
- Open positions with live P&L
- Recent trades with outcomes
- Performance metrics chart
- Latest signals from scans
```

## Key Files to Monitor

```bash
# Daily decision logs (append-only)
tail -f /workspace/group/memory/trading/decisions/$(date +%Y-%m-%d).jsonl

# Database positions
sqlite3 /workspace/project/store/messages.db "SELECT * FROM trading_positions WHERE status='open';"

# Performance metrics
sqlite3 /workspace/project/store/messages.db "SELECT * FROM performance_metrics ORDER BY date DESC LIMIT 7;"
```

---

**Remember:** All trades are PAPER MODE by default. No real money until you change `mode: "live"` after meeting graduation criteria!
