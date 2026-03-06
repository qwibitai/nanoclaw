---
name: performance-dashboard
description: Generate P&L reports and performance dashboards. Provides per-strategy analytics, daily/weekly summaries, and formatted Discord reports. Responds to !dashboard commands.
allowed-tools: Bash(neo_api:*, python3:*)
---

# Performance Dashboard

## Objective
Generate clear, actionable performance reports for Discord and API consumption.

## Tasks

### 1. Hourly Summary
```bash
# Portfolio value
neo_api db "SELECT total_eur, created_at FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1"

# Open positions count
neo_api db "SELECT count(*) FROM neo_positions WHERE status='open'"

# Daily P&L
neo_api db "SELECT date, pnl_eur, trades_count, win_rate FROM neo_daily_pnl ORDER BY date DESC LIMIT 7"
```

### 2. Strategy Breakdown
```bash
neo_api db "SELECT strategy, count(*) as trades, round(avg(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as wr, round(sum(pnl_eur), 2) as total_pnl, round(avg(pnl_pct), 2) as avg_pnl_pct FROM neo_positions WHERE status='closed' AND closed_at > now() - interval '7 days' GROUP BY strategy ORDER BY total_pnl DESC"
```

### 3. Format Report
Output format for Discord:
```
NEO Performance Dashboard
========================
Portfolio: EUR270.00 (+2.1% 24h)
Open: 10 Binance | 1 Degen

Strategy Performance (7d):
  momentum_breakout: 5 trades, 60% WR, +EUR8.50
  scalp_momentum:    3 trades, 67% WR, +EUR4.20
  degen:             8 trades, 25% WR, -EUR3.10

Daily P&L:
  Feb 25: +EUR2.30 (5 trades, 60% WR)
  Feb 24: -EUR1.10 (3 trades, 33% WR)
  Feb 23: +EUR5.40 (7 trades, 71% WR)

Risk: Floor EUR180 | HWM EUR258 | Kill: OFF
```

### 4. On-Demand (via !dashboard)
When triggered by Discord command, generate full report and write to:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-dashboard:report', '{\"text\": \"...\", \"timestamp\": \"ISO\"}', 'neo-dashboard') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Important
- Read-only. Never modify positions or execute trades.
- Round all EUR values to 2 decimals.
- Use relative timeframes (24h, 7d) not absolute dates.
