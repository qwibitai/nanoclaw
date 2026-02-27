---
description: Exponential trading account growth comes from building statistical playbook of when to size up, not emotional gut feelings
topics: [trading, position-sizing, risk-management]
created: 2026-02-27
---

# Size based on math not gut feeling for exponential growth

## Core Principle

"Over time you will start to build a playbook using MATH as to when you should bet more. This is what leads to eventual exponential growth." - Luckshury

## The Wrong Approach

**Emotional sizing**:
- "This one feels good" → size up
- "I have a gut feeling" → increase risk
- "I'm on a winning streak" → bet bigger

Results: Inconsistent returns, eventual blowup when gut feeling is wrong

## The Right Approach

**Mathematical sizing**:
- Keep **consistent input variables**: Same risk %, same setup criteria
- Focus on **quality over quantity**: Wait for high-probability setups
- Build **statistical playbook**: Document when edge is strongest
- Size up based on **measurable conditions**, not emotions

## How to Build Math-Based Playbook

### 1. Track Performance by Conditions

Record every trade with:
- Market condition (trending, range-bound, volatile, quiet)
- Time of day/week (if relevant)
- Setup type
- Result (P&L, R-multiple)

### 2. Identify High-Edge Scenarios

Over time, patterns emerge:
- "My edge is 2x stronger during XYZ condition"
- "Setup A has 65% win rate, Setup B has 45%"
- "Trades taken after ABC confirmation win 70% vs 50% without"

### 3. Adjust Size Mathematically

When high-edge scenario appears:
- **Kelly Criterion**: f* = (p×b - q) / b automatically handles this
- **Confidence-based**: Size = base_size × confidence_multiplier
- **Statistical**: Size = base_size × (observed_edge / baseline_edge)

NOT: "I feel good about this" → 3x size

## For Prediction Markets

Math-based sizing for PM:

```
Base sizing (Kelly):
f* = (true_prob × odds - (1-true_prob)) / odds

Adjust for confidence:
actual_size = kelly_size × confidence_factor

Where confidence based on:
- Information quality (hard data vs speculation)
- Sample size (polls of 10k vs 100)
- Time to resolution (closer = less uncertainty)
- Your historical accuracy on this event type
```

Example playbook findings:
- "Fed rate decisions: My probability estimates 85% accurate → use full Kelly"
- "Bitcoin price targets: Only 60% accurate → use half Kelly"
- "Political primaries with <100 days out: 75% accurate → use 0.75 Kelly"

## Why This Leads to Exponential Growth

**Consistent small edge + optimal sizing = compound growth**

With emotional sizing:
- Win 3x on good feeling → lose 5x on bad feeling → net loss
- Variance in sizing destroys edge

With math-based sizing:
- Win more when edge is strong
- Win less (or small loss) when edge is weak
- Compounds over time
- Risk of ruin minimized

## The Discipline Required

**Hardest part**: NOT sizing up when you "feel good" but math says baseline size

Example scenario:
- You've won last 5 trades
- Emotionally: "I'm hot, let me 3x this next one!"
- Math: "My edge hasn't changed, this setup is standard quality"
- **Correct action**: Baseline size, despite feeling

## Implementation Steps

1. **Define baseline size** (e.g., 2% of capital, or Kelly with standard confidence)
2. **Document conditions** for every trade
3. **Analyze after 50+ trades** to find patterns
4. **Create sizing rules** based on statistical edge by condition
5. **Backtest rules** on historical data
6. **Implement gradually** (don't immediately 3x size even if math supports it)

## Related Notes

- [[Pre-accepting failure rates enables rational decision making]]
- [[Judge systems by distributions not individual outcomes]]
- [[Prove edge before scaling capital not account size]]

---
*Topics: [[trading]] · [[position-sizing]] · [[risk-management]]*
