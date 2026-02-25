---
name: breeze
description: Breeze provides automated yield strategies on Solana. Deposit tokens, earn yield, and withdraw anytime. Perfect for AI agents managing DeFi yield farming without manual strategy management.
---

# Breeze — Yield & Lending Skill

## Overview
Breeze provides automated yield strategies on Solana. Deposit tokens, earn yield, and withdraw anytime. Perfect for AI agents managing DeFi yield farming without manual strategy management.

## Authentication
- **Header:** `x-api-key: <your-key>`
- **Base URL:** `https://api.breeze.baby`
- **Environment variable:** `BREEZE_API_KEY`

**Required:** API key is required for all endpoints.

## Capabilities

### Yield Strategies
| MCP Tool | Description | Notes |
|----------|-------------|-------|
| `breeze_get_strategies` | Get strategy info + APY | Default strategy supported |
| `breeze_deposit` | Deposit into strategy | **Human-readable amounts** |
| `breeze_withdraw` | Withdraw from strategy | **Auto unwrap SOL** |
| `breeze_get_balances` | Get user positions + yield | **Returns array** with UI amounts |
| `breeze_get_yield` | Get total yield earned | Aggregated across strategies |

## MCP Tool Usage

### Get Strategies
```json
{
  "strategyId": "43620ba3-354c-456b-aa3c-5bf7fa46a6d4"
}
```
Returns strategy info including APY per asset. Strategy ID is optional (uses default).

### Deposit (✅ Human-Readable Amounts!)
```json
{
  "userId": "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB",
  "mint": "So11111111111111111111111111111111111111112",
  "amount": "0.1"
}
```

**✅ Human-readable amounts:** Pass "0.1" for 0.1 SOL, "100" for 100 USDC
**✅ Auto-converts:** MCP tool converts to base units using token decimals
**✅ Returns:** Base64 transaction to sign with Crossmint

**Supported tokens:** SOL, USDC, USDT, USDS, JupSOL, JLP, mSOL, JitoSOL

### Withdraw (✅ Auto Unwrap SOL!)
```json
{
  "userId": "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB",
  "mint": "So11111111111111111111111111111111111111112",
  "amount": "0.05"
}
```

**✅ Auto unwrap:** For SOL withdrawals, automatically adds `unwrap_wsol_ata: true`
**✅ Returns:** Base64 transaction (unwraps wSOL → native SOL)

### Get Balances (✅ UI Amounts!)
```json
{
  "userId": "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB"
}
```

**Returns array** with UI-readable amounts:
```json
[
  {
    "strategy_name": "try-breeze-all-assets",
    "token_symbol": "USDC",
    "total_position_value": 1000000,
    "positionUI": "1.000000",
    "depositedUI": "1.000000",
    "yieldEarnedUI": "0.000000",
    "apy": 4.96
  }
]
```

**✅ Fixed:** Returns array directly (not `{ data, meta }`)

## Real-World Test Results

✅ **Tested:** 1 USDC deposit → withdraw
✅ **Deposit time:** ~10 seconds to confirm
✅ **Withdraw time:** ~10-20 seconds to confirm
✅ **APY:** 4.96% for USDC, 5% for SOL
✅ **Dust remaining:** 0.000001 USDC (negligible)

Both deposit and withdraw flows work perfectly with Crossmint signing!
