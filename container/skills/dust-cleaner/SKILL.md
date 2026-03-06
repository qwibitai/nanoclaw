---
name: dust-cleaner
description: Clean up tiny dust positions across all exchanges. Identifies positions worth less than $3, sells them via market order, and logs cleanup results. Handles Binance dust-to-BNB conversion.
allowed-tools: Bash(neo_api:*, python3:*)
---

# Dust Cleaner

## Objective
Identify and sell tiny "dust" positions that are too small to be worth holding but clutter the portfolio.

## Tasks

### 1. Identify Dust Positions
```bash
# Binance positions under $3
neo_api db "SELECT symbol, amount, current_price, (amount * current_price) as value_usd FROM neo_positions WHERE status='open' AND (amount * current_price) < 3 ORDER BY value_usd"

# Solana dust tokens
neo_api db "SELECT token_symbol, token_address, entry_price_usd FROM dex_positions WHERE status='open'"
```

Then check current value of each position against $3 threshold.

### 2. Execute Cleanup

For Binance dust:
```bash
# Use Binance dust-to-BNB feature for very small amounts
neo_api trade "!sell binance SYMBOL"
```

For Solana dust:
```bash
neo_api trade "!sell_sol TOKEN_ADDRESS"
```

### 3. Report Results
Write cleanup summary:
```bash
neo_api db "INSERT INTO neo_memory (category, key, value, updated_by) VALUES ('agent_signal', 'neo-housekeeping:dust_cleanup', '{\"cleaned\": 3, \"total_value_usd\": 2.50, \"positions\": [\"FLR\", \"KNC\", \"OMG\"], \"timestamp\": \"ISO\"}', 'neo-housekeeping') ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()"
```

## Schedule
Run every 2 hours.

## Important
- Only sell positions worth < $3 USD.
- Skip tokens that can't be priced (no quote available).
- Binance minimum order rules may prevent selling very tiny amounts — use dust-to-BNB conversion.
- Log every action for audit trail.
- Never sell positions in profit — only clean up worthless dust.
