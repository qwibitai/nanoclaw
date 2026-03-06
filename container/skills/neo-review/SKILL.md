---
name: neo-review
description: Review all open trading positions (DEX spot + perps) and decide HOLD/SELL/PARTIAL for each. Uses real-time market data, position age, PnL, and portfolio context. Triggered every 30min by neo-risk-agent or manually via /review.
allowed-tools: Bash(neo_api:*, curl:*, python3:*)
---

# NEO Position Review

## Objective
Review every open position across DEX spot and perps. For each position, output a clear HOLD / SELL / PARTIAL_SELL decision with reasoning. Write results to neo_memory for the engine to act on.

## When Triggered
- **Scheduled**: every 30 minutes by the neo-risk task
- **Manual**: user types `/review` in Discord

## Step 1: Gather Data

### Open DEX positions
```bash
neo_api db "SELECT token_address, token_symbol, entry_price_usd, current_price_usd, amount_tokens, amount_sol, pnl_usd, ROUND(EXTRACT(EPOCH FROM (now() - created_at))/3600, 1) as age_hours, status FROM dex_positions WHERE status='open' ORDER BY created_at"
```

### Open perp positions
```bash
neo_api db "SELECT asset, side, leverage, our_size_usd, our_collateral_sol, entry_price_usd, pnl_usd, ROUND(EXTRACT(EPOCH FROM (now() - detected_at))/3600, 1) as age_hours, status, target_wallet FROM copy_perp_positions WHERE status='open' ORDER BY detected_at"
```

### Recent closed trades (context)
```bash
neo_api db "SELECT token_symbol, pnl_usd, ROUND(EXTRACT(EPOCH FROM (closed_at - created_at))/3600, 1) as hold_hours FROM dex_positions WHERE status='closed' AND closed_at > now() - interval '48 hours' ORDER BY closed_at DESC LIMIT 10"
```

### SOL price + balances
```bash
neo_api balances
```

### Market context
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='market_data' ORDER BY updated_at DESC LIMIT 5"
```

### Portfolio risk state
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='system' AND key IN ('solana_hwm', 'solana_floor', 'daily_loss_usd', 'weekly_loss_usd') ORDER BY key"
```

## Step 2: Analyze Each Position

For each open position, evaluate:

### DEX Spot Positions
- **PnL %**: calculate from entry vs current price
- **Age**: positions > 4h with negative PnL lean toward SELL
- **Momentum**: if price declining steadily, SELL before further loss
- **Liquidity**: if liquidity dried up, exit immediately (can't sell later)
- **Stop Loss**: if PnL < -10%, hard SELL
- **Take Profit**: if PnL > +100%, PARTIAL_SELL 50%
- **Trailing**: if PnL was > +20% but now dropping, tighten or SELL

### Perp Positions
- **PnL vs leverage**: a 5x SHORT at -5% = -25% on collateral
- **Liquidation distance**: if price approaching liquidation, SELL
- **Whale alignment**: if copied from whale and whale closed, we should close too
- **Funding rate**: if paying high funding on wrong side, consider closing
- **Market trend**: if macro shifted against position direction, SELL

### Decision Rules
| Condition | Action |
|-----------|--------|
| PnL < -10% (spot) or collateral PnL < -30% (perp) | SELL |
| PnL > +100% | PARTIAL_SELL 50% |
| Age > 4h AND PnL < 0% | SELL (stale loser) |
| Strong momentum continuing | HOLD, tighten SL |
| Liquidity < $5k | SELL immediately |
| Whale source closed position | SELL (perps) |
| Volume dying + near zero PnL | SELL (avoid slow bleed) |

## Step 3: Output

For each position, output a JSON decision:

```json
{
  "positions": [
    {
      "identifier": "TOKEN_ADDRESS or ASSET_SIDE",
      "symbol": "TOKEN",
      "type": "dex_spot|perp",
      "action": "HOLD|SELL|PARTIAL_SELL",
      "sell_pct": 0,
      "reason": "Brief explanation",
      "urgency": "low|medium|high",
      "new_sl_pct": null
    }
  ],
  "portfolio_summary": {
    "total_open": 3,
    "total_unrealized_pnl_usd": -2.50,
    "risk_level": "low|medium|high",
    "recommendation": "Brief overall assessment"
  }
}
```

Then write the review to memory:
```bash
neo_api db "SELECT 1"
```
Note: Since neo_api db is read-only, output the JSON to stdout. The calling agent/engine will read your output and act on it.

## Important Rules
- NEVER execute trades directly — only output decisions
- In degen trading, 20-30% win rate is NORMAL if winners are 5-10x
- Don't panic-sell everything on a losing streak — judge each position individually
- Perps require faster decisions — leverage amplifies losses
- Always consider portfolio-level risk: if daily loss approaching limit, be more aggressive on exits
- If ALL positions are red and approaching daily loss limit → recommend closing weakest positions first
