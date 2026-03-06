---
name: neo-entry-check
description: Pre-entry gate for degen trades. Checks macro regime, portfolio exposure, correlation with open positions, and narrative quality before allowing a trade. Returns GO/NOGO with confidence score. Called by engine before executing any BUY.
allowed-tools: Bash(neo_api:*, curl:*, python3:*)
---

# NEO Entry Check — Pre-Trade Gate

## Objective
Final verification gate before the engine executes a BUY order. Checks conditions that the simple scoring in /evaluate might miss: macro regime, portfolio-level exposure, correlation risk, and organic vs manipulated narratives.

## When Triggered
- **Engine call**: after /evaluate returns BUY with score >= 5, engine calls /entry-check as final gate
- **Manual**: user types `/entry-check` with opportunity data

## Step 1: Gather Context

### Macro regime
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='agent_signal' AND key LIKE 'neo-strategy:%' ORDER BY updated_at DESC LIMIT 1"
```

### Current exposure
```bash
neo_api db "SELECT COUNT(*) as open_count, COALESCE(SUM(amount_sol), 0) as total_sol_deployed FROM dex_positions WHERE status='open'"
```

### Today's performance
```bash
neo_api db "SELECT COALESCE(SUM(pnl_usd), 0) as daily_pnl, COUNT(*) as trades_today FROM dex_positions WHERE status='closed' AND closed_at > CURRENT_DATE"
```

### Risk state
```bash
neo_api db "SELECT key, value FROM neo_memory WHERE category='system' AND key IN ('solana_hwm', 'solana_floor', 'daily_loss_usd', 'kill_switch_active') ORDER BY key"
```

### Correlation check (same narrative/sector)
```bash
neo_api db "SELECT token_symbol, token_address FROM dex_positions WHERE status='open'"
```

### SOL price
```bash
neo_api balances
```

## Step 2: Evaluate Gate Conditions

The opportunity JSON is passed as input context (same format as /evaluate).

### Gate Checks

| Check | Condition | Result |
|-------|-----------|--------|
| Kill switch | active | NOGO |
| Daily loss | > 80% of limit | NOGO |
| Open positions | >= 5 concurrent | NOGO |
| Total SOL deployed | > 50% of balance | NOGO (overexposed) |
| Macro regime | risk-off (BTC dropping, fear high) | NOGO if score < 8 |
| Correlation | same narrative/sector as 2+ open positions | NOGO (concentrated) |
| Liquidity | < $5,000 | NOGO (can't exit) |
| Bundle % | > 30% | NOGO (insider heavy) |
| Token age | < 3 minutes | NOGO (too new, rug risk) |
| Narrative check | random gibberish name, no trend | Reduce confidence |
| Wash trading | vol/liq > 50 | NOGO (fake volume) |
| Dev wallet | > 20% supply | NOGO (rug risk) |

### Organic vs Manipulated
- Check if multiple scanners found the token (organic discovery)
- Single-source tokens with explosive pump = likely manipulation
- Telegram-sourced tokens get benefit of doubt (curated)
- Tokens with trending narrative keywords = organic bonus

## Step 3: Output Format

```json
{
  "decision": "GO",
  "confidence": 82,
  "checks_passed": 8,
  "checks_failed": 0,
  "checks_warning": 2,
  "warnings": ["macro slightly risk-off", "only 65 holders"],
  "blockers": [],
  "reasoning": "Strong narrative token, healthy liquidity, portfolio has room. Macro cautious but token-specific momentum overrides.",
  "suggested_adjustments": {
    "reduce_size_pct": 0,
    "tighten_sl": false
  }
}
```

For NOGO:
```json
{
  "decision": "NOGO",
  "confidence": 95,
  "checks_passed": 5,
  "checks_failed": 3,
  "checks_warning": 1,
  "warnings": ["low holder count"],
  "blockers": ["daily loss at 85% of limit", "3 positions already open in same sector", "macro risk-off"],
  "reasoning": "Portfolio overexposed to meme sector, daily loss near limit. Not the time for new entries.",
  "suggested_adjustments": null
}
```

## Important Rules
- NEVER execute trades — only gate decisions
- This is the LAST check before execution — be conservative when in doubt
- If even one NOGO blocker exists, the answer is NOGO
- Warnings alone don't block, but 3+ warnings should increase caution
- Always check kill switch FIRST — if active, immediate NOGO
- Portfolio health > individual opportunity quality
