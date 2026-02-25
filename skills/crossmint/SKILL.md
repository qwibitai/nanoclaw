---
name: crossmint
description: Crossmint provides custodial wallet-as-a-service, NFT minting, virtual debit cards, crypto-to-fiat payouts, and **transaction signing** on Solana. Perfect for AI agents managing DeFi operations without needing a local keypair.
---

# Crossmint — Wallets & Payments Skill

## Overview
Crossmint provides custodial wallet-as-a-service, NFT minting, virtual debit cards, crypto-to-fiat payouts, and **transaction signing** on Solana. Perfect for AI agents managing DeFi operations without needing a local keypair.

## Authentication
- **Header:** `X-API-KEY: sk_staging_...` or `sk_production_...`
- **Staging (devnet):** `https://staging.crossmint.com/api`
- **Production (mainnet):** `https://www.crossmint.com/api`
- **Environment variable:** `CROSSMINT_ENVIRONMENT` — set to `production` for mainnet

**Important:** Wallets created on production only exist on mainnet. Staging uses devnet addresses.

## Wallet Locator Formats

Crossmint uses locator strings to identify wallets:

| Format | Example | Use Case |
|--------|---------|----------|
| Email | `email:user@example.com:solana` | Link wallet to email |
| User ID | `userId:abc123:solana` | Link wallet to custom user ID |
| Bare address | `9bcWvn6HSMK9WoiUktc2MJ4ht2CGn389b4wMAQRTrCjZ` | Reference by address |

**✅ Fixed:** All endpoints now accept bare addresses directly. The SDK no longer adds `solana:` prefix.

## API Request Format

**Write endpoints** (transfer, signTransaction, signMessage, fund) wrap the body in a `params` object:

```json
{
  "params": {
    "transaction": "base58-encoded-tx"
  }
}
```

The SDK handles this wrapping automatically.

**✅ Fixed:** The `encoding` parameter is no longer accepted by Crossmint. Base58 is the default and only format.

## Capabilities

### Wallet Management
| MCP Tool | Description | Notes |
|----------|-------------|-------|
| `crossmint_create_wallet` | Create custodial wallet | Pass `email` or `userId` |
| `crossmint_get_balance` | Get wallet balances | **Must specify tokens array** |
| `crossmint_transfer` | Transfer tokens | Between wallets |
| `crossmint_sign_transaction` | Sign & send transaction | **Auto base64→base58** conversion |

### Signing Flow (Critical for DeFi)

Custodial wallets don't expose keypairs. Use this flow:

```
1. Get unsigned tx from Breeze/DFlow (returns base64)
2. crossmint_sign_transaction(locator, tx) → auto-converts to base58 & signs
3. Returns { id, status, onChain: { transaction, lastValidBlockHeight } }
```

**Transaction encoding:**
- ✅ Breeze/DFlow return **base64**
- ✅ Crossmint expects **base58**
- ✅ `crossmint_sign_transaction` MCP tool **auto-converts**

**Response format changed:**
- Old: `{ actionId, transactionHash }`
- New: `{ id, status, onChain: { transaction, lastValidBlockHeight } }`

### NFT Minting
| MCP Tool | Description |
|----------|-------------|
| `crossmint_mint_nft` | Mint NFT to recipient |

### Virtual Cards
| MCP Tool | Description |
|----------|-------------|
| `crossmint_create_card` | Create virtual debit card |

### Payouts (Off-Ramp)
| MCP Tool | Description |
|----------|-------------|
| `crossmint_create_payout` | Payout crypto to bank/wallet |

## MCP Tool Usage

### Create Wallet
```json
{
  "type": "solana-custodial-wallet",
  "email": "user@example.com"
}
```
Returns wallet with address. Wallets are persistent across sessions with same email+API key.

### Get Balance
```json
{
  "locator": "9bcWvn6HSMK9WoiUktc2MJ4ht2CGn389b4wMAQRTrCjZ",
  "tokens": ["sol", "usdc"]
}
```
**Required:** Must specify `tokens` array.

### Sign Transaction
```json
{
  "locator": "9bcWvn6HSMK9WoiUktc2MJ4ht2CGn389b4wMAQRTrCjZ",
  "transaction": "<base64 or base58 transaction>"
}
```
Auto-detects format and converts base64→base58 if needed.

## Example Workflow

```typescript
// 1. Create wallet
const wallet = await crossmint_create_wallet({
  type: "solana-custodial-wallet",
  email: "agent@example.com"
});

// 2. Check balance
const balances = await crossmint_get_balance({
  locator: wallet.address,
  tokens: ["sol", "usdc"]
});

// 3. Get unsigned tx from Breeze (returns base64)
const depositTx = await breeze_deposit({
  userId: wallet.address,
  amount: "0.1",  // Human-readable
  mint: "So11111111111111111111111111111111111111112"
});

// 4. Sign and send (auto-converts base64→base58)
const result = await crossmint_sign_transaction({
  locator: wallet.address,
  transaction: depositTx.transaction
});

console.log("Transaction ID:", result.id);
console.log("Tx Hash:", result.onChain.transaction);
```

## Known Issues & Fixes

✅ **Locator format:** No longer adds `solana:` prefix (caused 400 errors)
✅ **Encoding parameter:** Removed (Crossmint rejected it)
✅ **Response format:** Now returns `{ id, status, onChain }` instead of `{ actionId, transactionHash }`
✅ **Base64/Base58:** MCP tool auto-converts for you

## Common Gotchas

- **Balances require tokens array** — You must specify which tokens to query
- **Write endpoints wrap params** — SDK handles this automatically
- **Persistent wallets** — Same email+API key = same wallet across sessions
- **Production vs Staging** — Wallets don't exist across environments

## Installation

```bash
npm install agent-finance-sdk
```

```typescript
import { CrossmintClient } from "agent-finance-sdk";

const cm = new CrossmintClient({
  apiKey: "sk_production_...",
  environment: "production"
});
```
