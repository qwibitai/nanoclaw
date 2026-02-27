# Intraday Bitcoin Trading Setup (5-min & 15-min)

Quick start guide for high-frequency Bitcoin prediction market trading.

## 🎯 What's Different from Daily Trading

| Feature | Daily Trading | Intraday (5/15-min) |
|---------|---------------|---------------------|
| **Timeframe** | 1-5 days | 10-120 minutes |
| **Signals/Day** | 1-3 | 5-15 |
| **Position Size** | 10% max | 5% max |
| **Stop Loss** | 5% | 2-4% |
| **Profit Target** | 10-20% | 3-6% |
| **Win Rate** | 78% | 60-65% |
| **Max Hold Time** | 5 days | 1-2 hours |
| **Tool** | `trading__analyze_market` | `trading__analyze_market_intraday` |
| **Scanning** | Once daily (3:50 PM) | Every 5 or 15 minutes |

---

## 🚀 Quick Start

### 1. Test Intraday Scanning

```
Use tool: trading__analyze_market_intraday
{
  "timeframe": "5min",
  "platform": "all",
  "min_confidence": 0.65
}
```

**Expected Output**:
```
🔍 Intraday Scan Complete (5min)

Found 4 signals across 5 Bitcoin markets

Top 3 Opportunities:
1. BTC_100K_2024 (polymarket) [5min]
   BUY @ 0.4523 - 72.1% confidence
   Intraday oversold (5min): RSI(7) = 23.1 < 25. Volume: 75,000 (strong).
   Stop: 0.4432 | Target: 0.4659 | Max Hold: 60min

2. BITCOIN-100K-2024 (kalshi) [5min]
   SELL @ 0.5812 - 68.3% confidence
   Momentum breakout detected: -1.23% price change with 2.1x volume surge.
   Stop: 0.5930 | Target: 0.5635 | Max Hold: 60min

⏰ Next scan: 5 minutes
```

### 2. Execute an Intraday Trade

```
Use tool: trading__place_trade
{
  "symbol": "BTC_100K_2024",
  "platform": "polymarket",
  "action": "buy",
  "mode": "paper",
  "size": 400,  // 4% of $10K portfolio
  "limit_price": 0.4523,
  "confidence": 0.72,
  "volatility": 0.01
}
```

### 3. Monitor Position

Set alerts for:
- ✅ Profit target: 0.4659 (+3%)
- 🛑 Stop loss: 0.4432 (-2%)
- ⏱️ Time stop: 60 minutes

Exit IMMEDIATELY when any trigger hits.

---

## 📅 Intraday Schedule Options

### Option A: 5-Minute Active Scalping

**For**: Maximum opportunities, full attention required
**Schedule**: Every 5 minutes, 9 AM - 4 PM EST

```bash
# Scheduled task (cron: */5 9-16 * * *)
Every 5 minutes:
1. Run trading__analyze_market_intraday({ timeframe: "5min" })
2. If signal confidence > 70%:
   - Execute trade immediately
   - Set stop/target/time alerts
3. Check open positions every minute
4. Exit on stop/target/time trigger
```

**Expected**:
- 8-12 signals/day
- 5-10 executed trades
- Avg hold: 15-30 minutes
- Daily P&L: +2-4% (good days), -1-2% (bad days)

### Option B: 15-Minute Swing Scalping

**For**: Less intensive, can multi-task
**Schedule**: Every 15 minutes, 9 AM - 4 PM EST

```bash
# Scheduled task (cron: */15 9-16 * * *)
Every 15 minutes:
1. Run trading__analyze_market_intraday({ timeframe: "15min" })
2. If signal confidence > 70%:
   - Execute trade
   - Set alerts
3. Check positions every 5 minutes
4. Exit on triggers
```

**Expected**:
- 4-8 signals/day
- 3-6 executed trades
- Avg hold: 30-90 minutes
- Daily P&L: +1.5-3% (good days), -0.5-1.5% (bad days)

### Option C: Hybrid (Recommended for Testing)

**For**: Balance of activity and manageability
**Schedule**: 15-min scan, but look for 5-min setups too

```bash
# Every 15 minutes
1. Scan both timeframes:
   trading__analyze_market_intraday({ timeframe: "both" })

2. Priority:
   - 5-min signals if confidence > 75% (rare but high quality)
   - 15-min signals if confidence > 70% (more common)

3. Max 3 simultaneous positions
4. Strict stop/target/time discipline
```

---

## ⚠️ Intraday Risk Management

### Hard Limits (NEVER OVERRIDE)

```typescript
INTRADAY_LIMITS = {
  MAX_POSITION_SIZE: 5%,           // Half of daily (was 10%)
  MAX_DAILY_TRADES: 10,            // Prevent overtrading
  MAX_DAILY_DRAWDOWN: -5%,         // Stop trading if hit
  MAX_SIMULTANEOUS_POSITIONS: 3,   // Don't overlap too much
  STOP_AFTER_CONSECUTIVE_LOSSES: 3, // Take a break
  MIN_VOLUME: 50000,               // Skip low liquidity
}
```

### Circuit Breakers

**If 3 consecutive losses**:
```
PAUSE trading for 1 hour
Reason: Likely market regime change or bad luck cluster
Resume: After 1 hour or manual review
```

**If daily drawdown hits -5%**:
```
HALT all intraday trading for the day
Reason: Preserve capital, prevent tilt
Resume: Tomorrow with fresh mindset
```

---

## 📊 Intraday Strategies

### 1. RSI Mean Reversion (Primary)

**Setup**:
- 5-min: RSI(7) < 25 or > 75
- 15-min: RSI(9) < 20 or > 80
- Volume > minimum threshold

**Entry**: Immediate on signal
**Exit**: Profit target (3x stop) OR stop loss OR time stop

**Expected**:
- Win Rate: 62-65%
- Avg Win: +3.5%
- Avg Loss: -2.2%
- Avg Hold: 25 minutes (5-min), 60 minutes (15-min)

### 2. Momentum Breakout (Secondary)

**Setup**:
- Price change > 1% in last 10 candles
- Volume surge > 1.5x average
- Clear direction (up or down)

**Entry**: Buy breakout up, sell breakout down
**Exit**: Momentum fades OR profit target

**Expected**:
- Win Rate: 58-62%
- Avg Win: +4.2%
- Avg Loss: -2.5%
- Avg Hold: 45 minutes

### 3. Support/Resistance Bounce (Tertiary)

**Setup**:
- Price within 10% of recent high/low
- RSI confirmation (oversold at support, overbought at resistance)

**Entry**: Buy at support, sell at resistance
**Exit**: Bounce complete OR stop hit

**Expected**:
- Win Rate: 68-72%
- Avg Win: +3.0%
- Avg Loss: -2.0%
- Avg Hold: 20 minutes

---

## 🎓 Intraday vs Daily: When to Use Which

### Use Daily Trading (3:50 PM scan) When:
- ✅ You can't monitor positions constantly
- ✅ You want higher win rate (78% vs 65%)
- ✅ You prefer fewer, higher-quality signals
- ✅ You're building initial trading history

### Use Intraday Trading (5/15-min scan) When:
- ✅ You can actively monitor positions
- ✅ You want more trading opportunities
- ✅ You're comfortable with faster pace
- ✅ You have validated strategy with 50+ daily trades first

### Use Both (Hybrid) When:
- ✅ Daily scan for swing trades (1-5 day holds)
- ✅ Intraday scan for scalps (10-120 min holds)
- ✅ Keep them separate in tracking
- ✅ Allocate capital separately (e.g., 60% daily, 40% intraday)

---

## 📈 Performance Expectations

### Month 1 (Learning)
- Win Rate: 55-60%
- Daily P&L: ±2%
- Focus: Discipline, following stops

### Month 2-3 (Improving)
- Win Rate: 60-65%
- Daily P&L: +1-3%
- Focus: Pattern recognition, timing

### Month 4+ (Profitable)
- Win Rate: 65-70%
- Daily P&L: +2-4%
- Monthly: +20-30%

---

## 🚨 Common Mistakes (Avoid These!)

1. ❌ **Holding past time stop** → "It'll bounce back"
   - ✅ Always exit at max hold time

2. ❌ **Widening stops after entry** → "Give it more room"
   - ✅ Stop is stop, no changes

3. ❌ **Overtrading after wins** → "I'm on a roll!"
   - ✅ Stick to max 10 trades/day

4. ❌ **Revenge trading after losses** → "Need to make it back"
   - ✅ Take break after 3 consecutive losses

5. ❌ **Trading during low volume** → "Signal is signal"
   - ✅ Skip if volume < minimum

---

## 🔧 Testing Checklist

Before going live with intraday:

- [ ] Test `trading__analyze_market_intraday` manually
- [ ] Execute 20+ paper intraday trades
- [ ] Verify stop losses trigger correctly
- [ ] Verify profit targets trigger correctly
- [ ] Verify time stops trigger correctly
- [ ] Track win rate > 60%
- [ ] Track max drawdown < 5% daily
- [ ] Confirm you can monitor positions actively

---

## 📞 Monitoring Tools

### Dashboard
```
http://localhost:9100/api/trading/positions?status=open
View real-time open positions with P&L
```

### Database Query
```bash
sqlite3 /workspace/project/store/messages.db "
SELECT symbol, entry_price,
       (julianday('now') - julianday(entry_date)) * 24 * 60 as minutes_open,
       pnl
FROM trading_positions
WHERE status='open'
ORDER BY entry_date DESC;"
```

### Alert Script
```bash
# Check for positions past time stop
# Run every minute via cron

sqlite3 /workspace/project/store/messages.db "
SELECT id, symbol,
       (julianday('now') - julianday(entry_date)) * 24 * 60 as minutes
FROM trading_positions
WHERE status='open'
  AND (julianday('now') - julianday(entry_date)) * 24 * 60 > 60;"
```

---

## 🎯 Summary

**Intraday trading is faster, riskier, and requires more attention than daily trading.**

**Start with**:
- 15-minute timeframe (easier)
- Paper mode (safe)
- Max 5 trades/day (learn first)
- Strict stops (discipline)

**Graduate to**:
- 5-minute timeframe (more signals)
- Live mode (after 50+ profitable paper trades)
- Max 10 trades/day (if profitable)
- Tighter stops (confidence)

**Remember**: It's easier to make money with 1 good daily trade than 10 mediocre intraday trades. Only do intraday if you can commit to **active monitoring**.
