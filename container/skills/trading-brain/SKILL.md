---
name: trading-brain
description: AI-powered trade signal scoring and position review. Evaluates opportunities from the signal pipeline, reviews open positions for hold/sell decisions, and provides strategic assessments. Uses Claude for analysis with deterministic fallback.
allowed-tools: Bash(neo_api:*, python3:*)
---

# Trading Brain

## Objective
Score incoming trade signals and review open positions. Provide actionable hold/sell/buy decisions with reasoning.

## Tasks

### 1. Score Degen Signal (On-demand)
When a new degen opportunity arrives, evaluate it:

```bash
# Get pending signals
neo_api db "SELECT key, value FROM neo_memory WHERE category='agent_signal' AND key LIKE 'neo-intelligence:%' AND updated_at > now() - interval '10 minutes' ORDER BY updated_at DESC LIMIT 5"
```

Score 1-10 based on:
- Liquidity depth (>$10k = +2, >$50k = +3)
- Volume/liquidity ratio (1-5 = healthy, >30 = wash trading)
- Price momentum (5m positive + 1h positive = +2)
- Holder count (>50 = +1, >200 = +2)
- Pair age (>15min but <24h = sweet spot +2)
- Rug risk indicators (honeypot, dev wallet %, etc.)
- Historical win rate context (don't over-penalize, use 50% baseline if <10 trades)

### 2. Position Review (Every 8 minutes)
Review all open positions and decide hold/sell:

```bash
# Open Binance positions
neo_api db "SELECT symbol, amount, entry_price, current_price, pnl_pct, created_at FROM neo_positions WHERE status='open' ORDER BY created_at"

# Open degen positions
neo_api db "SELECT token_symbol, entry_price_usd, created_at FROM dex_positions WHERE status='open' ORDER BY created_at"

# Market context
neo_api db "SELECT value FROM neo_memory WHERE category='market' AND key='summary'"
```

For each position, output:
- `HOLD` — position is performing or has potential
- `SELL` — cut losses or take profit (with sell_pct: 50 or 100)
- `PARTIAL_SELL` — take partial profit

### 3. Strategic Review (Every 12 hours)
Analyze overall strategy performance:

```bash
# Last 7 days closed trades
neo_api db "SELECT symbol, pnl_pct, strategy, created_at, closed_at FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '7 days' ORDER BY closed_at DESC"

# Win rate by strategy
neo_api db "SELECT strategy, count(*) as trades, round(avg(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as wr FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '7 days' GROUP BY strategy"
```

## Output Format

Write decisions to DB:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-brain:score:SYMBOL', '{\"symbol\": \"SYMBOL\", \"score\": 7, \"action\": \"buy\", \"amount_sol\": 0.15, \"reasoning\": \"...\"}', 'neo-brain') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Important
- NEVER execute trades directly. Only output scores and decisions.
- When win rate data is sparse (<10 trades), use 50% baseline — don't punish new strategies.
- Consider position age: stale positions (>4h, negative PnL) should lean toward SELL.
- Factor in market regime: risk-off = tighter SL, risk-on = let winners run.
