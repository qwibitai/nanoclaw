# Prediction Market Trading Framework

**Core Principle**: You're trading **probabilities of events**, not stock prices.

## What Prediction Markets Are

- **Binary outcome contracts**: Event happens (pays $1) or doesn't (pays $0)
- **Prices represent probability**: 0.65 = 65% chance event occurs
- **Fixed resolution date**: Event resolves, market settles
- **Information-driven**: Price changes reflect new information about event

## Trading Edge Sources

### 1. Better Probability Model
```
Your estimate: 40% chance Fed cuts rates in March
Market price: 0.60 ($0.60 per $1 contract)
Edge: Market overpricing by 20 percentage points
Action: SELL at 0.60
```

### 2. Faster Information Processing
```
News drops: Inflation report shows 3.5% (higher than expected)
Market hasn't adjusted yet (still pricing 45% cut probability)
Your instant analysis: This drops cut probability to 25%
Action: SELL before market reprices
```

### 3. Time Decay Understanding
```
"BTC hits $100K by Dec 31, 2024"
June: Market at 0.50 (6 months left, lots of uncertainty)
November: BTC at $70K, market still at 0.30
Your analysis: Would need 43% gain in 1 month = <5% probability
Market still has "hope premium"
Action: SELL at 0.30
```

### 4. Liquidity Arbitrage
```
Same event on two platforms:
Polymarket: "Trump wins" at 0.65
Kalshi: "Trump wins" at 0.60
Action: Buy Kalshi, sell Polymarket, capture 5-point spread
```

## Analysis Framework

### Step 1: Calculate True Probability

**Sources**:
- Statistical models (polling aggregators, prediction models)
- Historical base rates (how often does X happen?)
- Domain expertise (understand the event deeply)
- Bayesian updating (prior × new evidence = posterior)

**NOT**:
- RSI levels
- Moving averages
- Chart patterns
- "Oversold" conditions

### Step 2: Compare to Market Price

```
True probability estimate: P_true
Market price: P_market
Edge: P_true - P_market

If edge > threshold (e.g., 10 points):
  - P_true > P_market → BUY
  - P_true < P_market → SELL
```

### Step 3: Assess Confidence

**High confidence indicators**:
- Hard data (official statistics, confirmed facts)
- High-quality polls (large sample, good methodology)
- Clear causal mechanisms
- Low uncertainty about event definition

**Low confidence indicators**:
- Speculation without data
- Small sample sizes
- Ambiguous event resolution criteria
- Long time horizon (lots can change)

### Step 4: Time Horizon Analysis

**Questions**:
- How long until resolution?
- Are there catalysts between now and then?
- Does time decay help or hurt my position?
- Can new information change probability significantly?

### Step 5: Execution Decision

```
IF: edge > 10 points
AND: confidence > 70%
AND: time horizon favorable
AND: liquidity sufficient
THEN: Trade

Position size = f(edge, confidence, bankroll)
  - Use Kelly Criterion: f* = (p*b - q) / b
  - Where p = your probability, q = 1-p, b = odds
```

## Example: Correct Prediction Market Analysis

### Event: "Fed cuts rates in March 2024"

**Step 1: Calculate True Probability**
```
Data:
- Current inflation: 3.2% (target: 2%)
- Last Fed statement: "Need to see sustained progress"
- Employment: Strong (unemployment 3.7%)
- Fed funds futures: Pricing 25% cut probability
- Historical: Fed rarely cuts with inflation >3%

Base rate: Fed cuts with inflation >3% = 10% historical
Current conditions: Inflation falling but slowly
Fed communication: Dovish but patient

Bayesian estimate:
Prior: 10% (base rate)
Update for inflation trend: ×1.5 (falling, but not fast enough)
Update for Fed communication: ×1.2 (slightly dovish)
Update for employment: ×0.8 (too strong for urgency)

Posterior: 10% × 1.5 × 1.2 × 0.8 = 14.4% ≈ 15%

True probability estimate: 15%
```

**Step 2: Compare to Market**
```
Market price: 0.45 (45%)
True estimate: 0.15 (15%)
Edge: -30 points (market WAY overpriced)
```

**Step 3: Assess Confidence**
```
Data quality: HIGH (official Fed data, clear statements)
Model uncertainty: MEDIUM (Fed could surprise, but unlikely)
Overall confidence: 75%
```

**Step 4: Time Horizon**
```
Current: February 15
Resolution: March 20 (Fed meeting)
Time: 5 weeks

Catalysts before resolution:
- Feb 23: PCE inflation data (could change estimate)
- March 8: Jobs report (could change estimate)

Assessment: Moderate time for new info, but thesis likely holds
```

**Step 5: Execution**
```
Edge: -30 points (huge!)
Confidence: 75%
Action: SELL at 0.45

Position sizing (Kelly):
p (market wrong) = 0.75
b (payoff if right) = 0.45 / 0.55 = 0.818
q (market right) = 0.25

f* = (0.75 × 0.818 - 0.25) / 0.818
f* = (0.614 - 0.25) / 0.818
f* = 0.445 = 44.5%

Conservative (Kelly/2): 22% of bankroll
With $10K bankroll: $2,200 position

Reasoning: Market pricing 45%, we estimate 15%, massive edge
           If we're right, contract goes to $0, we profit $0.45 per $1
           If we're wrong, we lose $0.55 per $1
           With 75% confidence of being right, this is +EV
```

## What This Framework Replaces

### ❌ OLD (Stock-Based):
```
Signal: RSI < 10
Reasoning: "Oversold, expect bounce"
Entry: Buy when RSI extreme
Exit: 5-day time stop or profit target
```

### ✅ NEW (Prediction Market):
```
Signal: Probability mispricing
Reasoning: "Market pricing 45%, true probability 15%, edge of 30 points"
Entry: When edge > threshold AND confidence > threshold
Exit: When new information changes probability estimate OR resolution
```

## Exit Criteria (Prediction Market Specific)

### Exit Reason 1: Thesis Invalidated
```
Example: Sold "March rate cut" at 0.45 based on inflation >3%
New info: Surprise inflation report shows 2.1% (target met!)
Action: EXIT immediately - thesis broken
```

### Exit Reason 2: Edge Disappeared
```
Example: Bought at 0.30, fair value 0.50
Market repriced to 0.48 (close to fair value)
Action: EXIT - edge is gone, no reason to hold
```

### Exit Reason 3: Better Opportunity
```
Example: Holding position with 10-point edge
New opportunity: 25-point edge elsewhere
Capital limited: Exit first position, reallocate
```

### Exit Reason 4: Time Decay Against You
```
Example: Long-dated binary option losing time value
Market approaching resolution without catalyst
Action: EXIT before time decay erodes value further
```

### Exit Reason 5: Liquidity Drying Up
```
Example: Market becomes illiquid (wide spreads)
Can't exit near fair value
Action: EXIT while you still can
```

### NOT: Arbitrary 5-day time stop
### NOT: Technical stop loss (RSI bounced)
### NOT: Profit target hit

## Position Management

### Scaling In/Out

**When to add to position**:
- New information STRENGTHENS thesis
- Edge INCREASES (market moves wrong way)
- Confidence INCREASES (more data confirms)

**When to reduce position**:
- New information slightly against thesis (not full exit yet)
- Edge DECREASES (market repricing toward fair value)
- Approaching resolution without thesis playing out

### Multiple Positions

**Correlation matters**:
```
Bad: "Trump wins" + "Republicans win Senate" + "Trump electoral votes >300"
  → All correlated, if wrong on one, likely wrong on all

Good: "Trump wins" + "Fed cuts rates" + "BTC hits $100K"
  → Uncorrelated events, diversification
```

## Risk Management (Prediction Market Specific)

### Position Sizing
```
NOT: Size based on volatility (stock concept)
YES: Size based on edge and confidence

Kelly Criterion:
f* = (p × b - q) / b

Where:
p = your estimated probability
q = 1 - p
b = odds (if betting YES: (1 - market_price) / market_price)

Conservative: Use Kelly / 2 or Kelly / 3
```

### Drawdown Management
```
Same as stocks: -25% max drawdown
But calculated differently:
- Stocks: Portfolio value vs peak
- Prediction markets: Track mark-to-market daily
  (positions have daily fair value, even if not trading)
```

### Correlation Limits
```
Max 30% in correlated events
Example:
- "Trump wins" at 20% of bankroll
- Can't add "Republicans win Senate" for >10% more
  (total correlated exposure would be 30%)
```

## Performance Metrics

### Win Rate (Different Interpretation)

**Stocks**: Win rate = % of closed positions profitable

**Prediction markets**: Win rate = % of probability estimates correct

**Example**:
```
Trade 1: Estimated 70%, market 50%, bought → Event happened → WIN
Trade 2: Estimated 30%, market 50%, sold → Event happened → LOSS
Trade 3: Estimated 80%, market 60%, bought → Event didn't happen → LOSS

Win rate: 1/3 = 33%
BUT: If position sizing was correct (larger on higher edge), could still be +EV
```

**Better metric**: Average edge captured
```
Trade 1: Edge = +20 points, outcome: +$0.50 per $1
Trade 2: Edge = -20 points, outcome: -$0.50 per $1
Trade 3: Edge = +20 points, outcome: -$0.40 per $1

Did we profit on average when we had edge? YES/NO
```

## Summary

**Prediction markets require:**
1. **Probability modeling** (not chart reading)
2. **Information processing** (not technical indicators)
3. **Bayesian updating** (not mean reversion)
4. **Kelly sizing** (not volatility-based)
5. **Thesis-driven exits** (not time/technical stops)

**Completely different from stocks.**

**Next step**: Rebuild trading system around these principles.
