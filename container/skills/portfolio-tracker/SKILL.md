---
name: portfolio-tracker
description: Unified portfolio tracking across Binance, Coinbase, and Solana. Takes periodic snapshots, calculates allocation percentages, monitors high-water mark, and provides capital allocation suggestions (HODL 30%, Swing 35%, Degen 25%, Cash 10%).
allowed-tools: Bash(neo_api:*, python3:*)
---

# Portfolio Tracker

## Objective
Track the unified portfolio across all exchanges/wallets and provide allocation insights.

## Tasks

### 1. Portfolio Snapshot (Every 20 minutes)
```bash
# Get current balances
neo_api balances

# Get open positions value
neo_api positions

# Latest portfolio total
neo_api db "SELECT total_eur, binance_eur, coinbase_eur, solana_eur, created_at FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1"
```

Write snapshot summary:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-portfolio:snapshot', '{\"total_eur\": 270, \"binance_eur\": 220, \"coinbase_eur\": 28, \"solana_eur\": 20, \"positions_count\": 10, \"timestamp\": \"ISO\"}', 'neo-portfolio') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

### 2. Capital Allocation Check (Every 2 hours)
Target allocation:
- **HODL (30%)**: BTC, ETH, SOL — long-term DCA positions
- **Swing (35%)**: Binance spot momentum trades
- **Degen (25%)**: Solana meme/pump tokens
- **Cash (10%)**: USDC/EUR reserves for opportunities

Check current vs target:
```bash
neo_api db "SELECT
  COALESCE(SUM(CASE WHEN symbol IN ('BTC','ETH','SOL') THEN current_value_eur ELSE 0 END), 0) as hodl,
  COALESCE(SUM(CASE WHEN symbol NOT IN ('BTC','ETH','SOL','USDC','EUR') THEN current_value_eur ELSE 0 END), 0) as swing
FROM neo_positions WHERE status='open'"
```

### 3. High-Water Mark Monitoring
```bash
neo_api db "SELECT value FROM neo_memory WHERE category='system' AND key='portfolio_hwm'"
neo_api db "SELECT value FROM neo_memory WHERE category='system' AND key='kill_switch'"
```

Report if portfolio drops >5% from HWM in a single cycle.

## Output
Write portfolio state and allocation recommendations to `neo_memory` (category='agent_signal').

## Important
- Read-only. Never execute trades or rebalance.
- Portfolio pricing may have gaps for illiquid tokens — use last known price.
- Include dust positions (<$3) in totals but flag them for cleanup.
