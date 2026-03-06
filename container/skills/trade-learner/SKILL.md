---
name: trade-learner
description: Analyze completed trades to identify patterns, improve strategy parameters, and track win/loss streaks. Reviews closed positions, computes per-strategy metrics, and suggests parameter adjustments.
allowed-tools: Bash(neo_api:*, python3:*)
---

# Trade Learner

## Objective
Learn from past trades to improve future performance. Analyze patterns in wins/losses and suggest parameter adjustments.

## Tasks

### 1. Trade Outcome Analysis (Every 4 hours)
```bash
# Recent closed trades
neo_api db "SELECT symbol, strategy, entry_price, exit_price, pnl_pct, pnl_eur, reason, created_at, closed_at FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '24 hours' ORDER BY closed_at DESC"

# Degen closed trades
neo_api db "SELECT token_symbol, entry_price_usd, exit_price_usd, pnl_pct, created_at, closed_at, close_reason FROM dex_positions WHERE status='closed' AND closed_at > now() - interval '24 hours' ORDER BY closed_at DESC"
```

### 2. Strategy Performance Metrics
```bash
# Win rate by strategy (last 7 days)
neo_api db "SELECT strategy, count(*) as trades, round(avg(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as win_rate, round(avg(pnl_pct), 2) as avg_pnl_pct FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '7 days' GROUP BY strategy ORDER BY trades DESC"

# Average hold time for winners vs losers
neo_api db "SELECT CASE WHEN pnl_pct > 0 THEN 'winner' ELSE 'loser' END as outcome, round(avg(EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600), 1) as avg_hours, count(*) FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '7 days' GROUP BY outcome"
```

### 3. Pattern Detection
Look for:
- **SL too tight**: Many positions hit SL then recover → suggest wider SL
- **TP too tight**: Positions sell at TP but keep pumping → suggest wider TP
- **Stale positions**: Average hold time of losers vs winners
- **Time-of-day patterns**: Are certain hours more profitable?
- **Source quality**: Which signal sources produce best win rates?

### 4. Suggestion Output
Write findings to DB:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-learner:suggestion', '{\"type\": \"parameter_adjust\", \"param\": \"SL_PCT\", \"current\": 6, \"suggested\": 8, \"reasoning\": \"60% of SL exits recover within 2h\", \"confidence\": 0.7}', 'neo-learner') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Important
- Analysis only. Never modify config or execute trades.
- Need at least 10 trades to make statistically meaningful suggestions.
- Weight recent trades more heavily (exponential decay).
