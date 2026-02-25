---
name: dflow
description: DFlow provides decentralized token swaps, prediction markets, and orderbook trading on Solana. Perfect for AI agents executing trades and participating in prediction markets.
---

# DFlow — Trading & Swaps Skill

## Overview
DFlow provides decentralized token swaps, prediction markets, and orderbook trading on Solana. Perfect for AI agents executing trades and participating in prediction markets.

## Authentication
- **Header:** `x-api-key: <your-key>`
- **Base URL:** `https://e.quote-api.dflow.net`
- **Environment variable:** `DFLOW_API_KEY`

**Note:** API key is optional for public endpoints (quotes, tokens, markets).

## Capabilities

### Token Swaps
| MCP Tool | Description | Notes |
|----------|-------------|-------|
| `dflow_get_quote` | Get swap quote | Amount in base units (lamports) |
| `dflow_swap` | Get swap transaction | **NEW!** Accepts human-readable amounts |
| `dflow_get_tokens` | List tradeable tokens | Get mint addresses |

### Prediction Markets
| MCP Tool | Description |
|----------|-------------|
| `dflow_get_markets` | List prediction markets |
| `dflow_get_orderbook` | Get market orderbook |
| `dflow_search_markets` | Search markets by keyword |

## MCP Tool Usage

### Get Quote
```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "10000000",
  "slippageBps": 50
}
```
**Amount:** Must be in base units (lamports for SOL, micro-units for USDC).

### Swap Tokens (✅ NEW!)
```json
{
  "userPublicKey": "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "0.01",
  "slippageBps": 50
}
```

**✅ Human-readable amounts:** Pass "0.01" for 0.01 SOL, not "10000000"
**✅ Auto-converts:** MCP tool converts to base units using token decimals
**✅ Returns:** `{ transaction, quote, lastValidBlockHeight }`

**Transaction format:**
- DFlow returns **base64** encoded transaction
- Use with `crossmint_sign_transaction` (auto-converts to base58)

### Get Tokens
```json
{}
```
Returns list of all tradeable tokens with mint addresses and metadata.

## Example Workflow: Swap SOL → USDC

```typescript
// 1. Get swap transaction (human-readable amount!)
const swap = await dflow_swap({
  userPublicKey: "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB",
  inputMint: "So11111111111111111111111111111111111111112",  // SOL
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
  amount: "0.01",  // 0.01 SOL (human-readable!)
  slippageBps: 50  // 0.5% slippage
});

console.log("Quote:", swap.quote);
console.log("Expected output:", swap.quote.outAmount, "USDC micro-units");
console.log("Price impact:", swap.quote.priceImpactPct + "%");

// 2. Sign and send via Crossmint (auto-converts base64→base58)
const result = await crossmint_sign_transaction({
  locator: "9wsmkna3YUau2oyXb62b7z373Drq2Nah1pX6WcPoqMgB",
  transaction: swap.transaction  // DFlow returns base64, Crossmint auto-converts
});

console.log("Swap executed:", result.onChain.transaction);
```

## Quote Response Format

```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "10000000",
  "outAmount": "891453",
  "otherAmountThreshold": "887542",
  "priceImpactPct": "0",
  "swapMode": "ExactIn",
  "slippageBps": 50,
  "routePlan": [...]
}
```

**Key fields:**
- `inAmount` — Input amount in base units (lamports)
- `outAmount` — Expected output in base units (micro-units)
- `priceImpactPct` — Price impact percentage as string
- `slippageBps` — Slippage tolerance in basis points (50 = 0.5%)

## Token Decimals

When using `dflow_get_quote` (low-level), you must convert to base units:

| Token | Mint | Decimals | Example |
|-------|------|----------|---------|
| SOL | `So11111111111111111111111111111111111111112` | 9 | 0.01 SOL = 10,000,000 lamports |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | 100 USDC = 100,000,000 micro-units |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 | 100 USDT = 100,000,000 micro-units |

**✅ With `dflow_swap`:** Just pass "0.01" — the MCP tool handles conversion!

## Known Issues & Fixes

✅ **Base64/Base58 conversion:** DFlow returns base64, Crossmint needs base58. The `crossmint_sign_transaction` MCP tool auto-converts.
✅ **Human-readable amounts:** New `dflow_swap` tool accepts "0.01" instead of "10000000"
✅ **Transaction signing:** Must use Crossmint (or similar) since DFlow doesn't sign transactions

## Common Gotchas

- **Quote amounts are base units** — Use `dflow_swap` for human-readable amounts
- **Slippage in basis points** — 50 bps = 0.5%, 100 bps = 1%
- **wrapAndUnwrapSol** — Automatically set to `true` in `dflow_swap` for SOL swaps
- **Transaction format** — DFlow returns base64, needs conversion to base58 for Crossmint

## Prediction Markets

DFlow also provides prediction markets. Use these MCP tools:

```typescript
// List active markets
const markets = await dflow_get_markets({ status: "active" });

// Search markets
const trumpMarkets = await dflow_search_markets({ query: "trump" });

// Get orderbook
const orderbook = await dflow_get_orderbook({ ticker: "TRUMP-WIN-2024" });
```

## Installation

```bash
npm install agent-finance-sdk
```

```typescript
import { DFlowClient } from "agent-finance-sdk";

const dflow = new DFlowClient({
  apiKey: "your-api-key",  // Optional for public endpoints
  rpcUrl: "https://api.mainnet-beta.solana.com"
});
```

## Real-World Test Results

✅ **Tested:** 0.02 SOL → 1.78 USDC swap
✅ **Price:** ~89 USDC per 1 SOL
✅ **Slippage:** 0.5% (50 bps)
✅ **Price Impact:** 0%
✅ **Time to confirm:** ~10 seconds

The swap executed successfully with Crossmint signing!
