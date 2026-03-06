---
name: neo-evaluate
description: Score degen/pump trading opportunities on a 1-10 scale. Decides BUY/SKIP with position sizing, SL/TP, and reasoning. Uses portfolio context, recent trade history, and narrative analysis. Called by engine via AgentBus or manually.
allowed-tools: Bash(neo_api:*, curl:*, python3:*)
---

# NEO Opportunity Evaluator

## Objective
Score incoming degen/pump opportunities and decide BUY or SKIP. Output a structured JSON with score, action, size, stop-loss, take-profit, and reasoning. This replaces the `claude_brain.score_degen_signal()` function.

## When Triggered
- **Engine call**: via AgentBus when a new opportunity is detected
- **Manual**: user types `/evaluate` with opportunity data
- The opportunity JSON is passed as input context

## Step 1: Gather Context

### Portfolio state
```bash
neo_api balances
```

### Open positions (avoid overexposure)
```bash
neo_api db "SELECT token_symbol, amount_sol, pnl_usd FROM dex_positions WHERE status='open'"
```

### Recent trade history (learn from past)
```bash
neo_api db "SELECT token_symbol, pnl_usd, ROUND(EXTRACT(EPOCH FROM (closed_at - created_at))/3600, 1) as hold_hours, exit_reason FROM dex_positions WHERE status='closed' AND closed_at > now() - interval '7 days' ORDER BY closed_at DESC LIMIT 15"
```

### Check if we traded this token before
```bash
neo_api db "SELECT token_symbol, pnl_usd, exit_reason, closed_at FROM dex_positions WHERE token_address='TOKEN_ADDRESS_HERE' ORDER BY closed_at DESC LIMIT 3"
```

### Daily PnL (budget check)
```bash
neo_api db "SELECT COALESCE(SUM(pnl_usd), 0) as daily_pnl FROM dex_positions WHERE status='closed' AND closed_at > CURRENT_DATE"
```

### Risk state
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='system' AND key IN ('solana_hwm', 'solana_floor', 'daily_loss_usd', 'kill_switch_active') ORDER BY key"
```

## Step 2: Evaluate the Opportunity

The opportunity arrives as a JSON with these fields:
- `token` / `symbol`: token name
- `token_address`: Solana address
- `price`: current price
- `mcap`: market cap USD
- `liquidity_usd`: pool liquidity
- `volume_1h_usd`: 1h volume
- `pump_5m_pct`, `pump_1h_pct`, `pump_24h_pct`: price changes
- `holders`: holder count
- `bundle_pct`: bundled/insider %
- `age_minutes`: pair age
- `source`: where detected (dexscreener, gecko_trending, telegram, pumpfun)
- `narrative_type`, `narrative_keyword`, `narrative_strength`: narrative analysis
- `multi_source_count`, `multi_source_names`: cross-source confirmation

### Scoring Criteria (1-10 scale)

| Factor | Score Impact |
|--------|-------------|
| Liquidity > $10k | +2 |
| Liquidity > $50k | +3 (instead of +2) |
| Volume/Liquidity ratio 1-5 | +1 (healthy) |
| Volume/Liquidity > 30 | -2 (wash trading) |
| 1h pump > 10% with positive 5m | +2 (active momentum) |
| Holders > 50 | +1 |
| Holders > 200 | +2 (instead of +1) |
| Age 15min - 24h | +2 (sweet spot) |
| Age < 5min | -1 (too new, rug risk) |
| Bundle % > 30% | SKIP (insider heavy) |
| Source = telegram | +2 bonus (curated) |
| Multi-source (2+ scanners) | +1 bonus |
| Strong narrative (strength >= 2) | +2 bonus |
| Political/celebrity/event token | +2 bonus (high retention) |
| NSFW/exploitative name | SKIP |
| Already traded & lost | -2 (caution) |
| Already traded & rugged | SKIP |
| Kill switch active | SKIP all |
| Daily loss near limit | -2 and reduce size |

### Baseline: score 5+ = BUY, score < 5 = SKIP

## Step 3: Position Sizing

If BUY:
- Base: 10% of SOL balance (minus 0.05 SOL gas reserve)
- If score >= 8: up to 15% (high conviction)
- If score 5-6: minimum 5% or $10 equivalent
- Clamp: min $10, max $75
- If already 3+ open positions: reduce size by 30%
- If daily loss > 50% of limit: reduce size by 50%

## Step 4: Output Format

```json
{
  "score": 7,
  "action": "BUY",
  "amount_sol": 0.15,
  "reasoning": "Strong narrative (political token), $45k liquidity, 35% pump in 1h, confirmed by 2 scanners. Age 2h in sweet spot.",
  "sl_pct": 10,
  "tp_pct": 100,
  "confidence": 0.75,
  "risk_factors": ["low liquidity relative to mcap", "only 80 holders"],
  "entry_strategy": "market buy"
}
```

For SKIP:
```json
{
  "score": 3,
  "action": "SKIP",
  "amount_sol": 0,
  "reasoning": "Liquidity only $3k, bundle% 45% indicates insider control. High rug risk.",
  "sl_pct": 0,
  "tp_pct": 0,
  "confidence": 0.9,
  "risk_factors": ["very low liquidity", "high bundle percentage"],
  "entry_strategy": "none"
}
```

## Important Rules
- NEVER execute trades — only score and output decisions
- In degen meme trading, 20-30% win rate is NORMAL and profitable if winners are 5-10x
- Don't reject good setups because of past losses on OTHER tokens — judge each on its merits
- Narrative tokens (political, celebrity, events) historically outperform random memes
- Prefer entry NEAR migration value, not after a massive pump
- If token already pumped > 200% in 24h, score lower (late entry)
- Recent losing streak on other tokens should NOT reduce score for a genuinely good setup
- Always check if kill switch is active — if yes, SKIP everything
- Score should reflect genuine opportunity quality, not risk aversion from recent losses
