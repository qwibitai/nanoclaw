# DFlow API Reference

Complete reference for all DFlow Swap API endpoints.

## Base URL

```
https://quote-api.dflow.net
```

## Authentication

Include API key in the `x-api-key` header:
```typescript
const headers = {
  "x-api-key": "your-api-key",
  "content-type": "application/json"
};
```

Contact `hello@dflow.net` to obtain an API key.

---

## Order API

### GET /order

Get a quote and transaction for spot or prediction market trades.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | string | Yes | Base58 input token mint address |
| `outputMint` | string | Yes | Base58 output token mint address |
| `amount` | integer | Yes | Input amount as scaled integer |
| `userPublicKey` | string | No | User wallet; include to get transaction |
| `slippageBps` | integer/string | No | Slippage in basis points or "auto" |
| `predictionMarketSlippageBps` | integer | No | Separate slippage for prediction markets |
| `platformFeeBps` | integer | No | Platform fee in basis points |
| `platformFeeScale` | integer | No | Fee scale multiplier |
| `prioritizationFeeLamports` | string/object | No | Priority fee configuration |

**Response (200):**

```json
{
  "outAmount": "150432100",
  "minOutAmount": "149679039",
  "priceImpactPct": "0.0234",
  "executionMode": "sync",
  "transaction": "base64-encoded-transaction",
  "computeUnitLimit": 200000,
  "lastValidBlockHeight": 289456123,
  "prioritizationFeeLamports": 150000,
  "routePlan": [
    {
      "venue": "Raydium",
      "marketKey": "...",
      "inputMint": "So11...",
      "outputMint": "EPjF...",
      "inAmount": "1000000000",
      "outAmount": "150432100"
    }
  ]
}
```

**Error Responses:**
- `400` - Invalid parameters
- `500` - Server error
- `503` - Service unavailable

---

### GET /order-status

Check status of an async order.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signature` | string | Yes | Base58 transaction signature |
| `lastValidBlockHeight` | integer | No | Block height for expiry check |

**Response (200):**

```json
{
  "status": "closed",
  "inAmount": "1000000000",
  "outAmount": "150432100",
  "fills": [
    {
      "signature": "...",
      "inAmount": "1000000000",
      "outAmount": "150432100",
      "timestamp": 1705234567
    }
  ],
  "reverts": []
}
```

**Status Values:**
| Status | Description |
|--------|-------------|
| `pending` | Order submitted, awaiting processing |
| `open` | Order opened on-chain |
| `pendingClose` | Filled, awaiting close transaction |
| `closed` | Successfully completed |
| `expired` | Transaction expired |
| `failed` | Execution failed |

---

## Imperative Swap API

### GET /quote

Get a quote for an imperative swap with full route control.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | string | Yes | Base58 input mint |
| `outputMint` | string | Yes | Base58 output mint |
| `amount` | integer | Yes | Input amount (scaled) |
| `slippageBps` | integer/string | No | Slippage or "auto" |
| `dexes` | string | No | Comma-separated DEXes to include |
| `excludeDexes` | string | No | Comma-separated DEXes to exclude |
| `platformFeeBps` | integer | No | Platform fee (basis points) |
| `platformFeeMode` | string | No | "inputMint" or "outputMint" |
| `sponsoredSwap` | boolean | No | Account for Token2022 fees |
| `destinationSwap` | boolean | No | Account for destination fees |
| `onlyDirectRoutes` | boolean | No | Single-leg routes only |
| `maxRouteLength` | integer | No | Maximum route legs |
| `onlyJitRoutes` | boolean | No | JIT routes only |
| `forJitoBundle` | boolean | No | Jito bundle compatible |

**Response (200):**

```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "1000000000",
  "outAmount": "150432100",
  "minOutAmount": "149679039",
  "otherAmountThreshold": "149679039",
  "priceImpactPct": "0.0234",
  "slippageBps": 50,
  "contextSlot": 289456000,
  "forJitoBundle": false,
  "requestId": "uuid-string",
  "simulatedComputeUnits": 180000,
  "routePlan": [
    {
      "venue": "Raydium",
      "marketKey": "abc123...",
      "data": "route-data",
      "inputMint": "So11...",
      "outputMint": "EPjF...",
      "inAmount": "1000000000",
      "outAmount": "150432100",
      "inputMintDecimals": 9,
      "outputMintDecimals": 6
    }
  ],
  "platformFee": {
    "amount": "0",
    "feeBps": 0
  }
}
```

---

### POST /swap

Generate a swap transaction from a quote.

**Request Body:**

```json
{
  "userPublicKey": "Base58-wallet-address",
  "quoteResponse": {
    // Full quote response from /quote
  },
  "computeUnitPriceMicroLamports": 1000,
  "dynamicComputeUnitLimit": true,
  "prioritizationFeeLamports": 150000,
  "wrapAndUnwrapSol": true,
  "feeAccount": "Base58-fee-account",
  "destinationTokenAccount": {
    "address": "Base58-address",
    "createIfNeeded": true
  },
  "includeJitoSandwichMitigationAccount": true,
  "positiveSlippage": {
    "mode": "split",
    "bps": 50
  }
}
```

**Required Fields:**
- `userPublicKey` - Signer's wallet address
- `quoteResponse` - Complete quote from /quote

**Optional Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `computeUnitPriceMicroLamports` | integer | CU price (mutually exclusive with prioritization) |
| `dynamicComputeUnitLimit` | boolean | Server calculates CU limit |
| `prioritizationFeeLamports` | various | See priority fee options |
| `wrapAndUnwrapSol` | boolean | Auto wrap/unwrap SOL |
| `feeAccount` | string | Platform fee recipient |
| `destinationTokenAccount` | object | Custom output account |
| `sponsor` | string | Sponsor wallet for gasless |
| `includeJitoSandwichMitigationAccount` | boolean | MEV protection |

**Response (200):**

```json
{
  "swapTransaction": "base64-encoded-transaction",
  "computeUnitLimit": 200000,
  "lastValidBlockHeight": 289456789,
  "prioritizationFeeLamports": 150000,
  "prioritizationType": "compute-budget"
}
```

---

### POST /swap-instructions

Get individual instructions for custom transaction building.

**Request Body:** Same as POST /swap

**Response (200):**

```json
{
  "instructions": [
    {
      "programId": "...",
      "accounts": [...],
      "data": "base64..."
    }
  ],
  "addressLookupTableAddresses": ["..."],
  "computeUnitLimit": 200000
}
```

---

## Declarative Swap API

### GET /intent

Get an intent quote for declarative swap.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | string | Yes | Base58 input mint |
| `outputMint` | string | Yes | Base58 output mint |
| `amount` | integer | Yes | Input amount (scaled) |
| `slippageBps` | integer | No | Slippage tolerance |
| `userPublicKey` | string | Yes | User's wallet |

**Response (200):**

```json
{
  "inputMint": "So11...",
  "outputMint": "EPjF...",
  "inAmount": "1000000000",
  "guaranteedOutAmount": "149000000",
  "estimatedOutAmount": "150432100",
  "slippageBps": 100,
  "transaction": "base64-unsigned-transaction",
  "lastValidBlockHeight": 289456789
}
```

---

### POST /submit-intent

Submit signed intent for execution.

**Request Body:**

```json
{
  "signedTransaction": "base64-signed-transaction",
  "intentResponse": {
    // Full response from /intent
  }
}
```

**Response (200):**

```json
{
  "orderId": "uuid",
  "status": "submitted",
  "openSignature": "...",
  "estimatedFillTime": 5000
}
```

---

## Token API

### GET /tokens

Get list of supported token mints.

**Response (200):**

```json
{
  "tokens": [
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  ]
}
```

---

### GET /tokens-with-decimals

Get tokens with decimal information.

**Response (200):**

```json
{
  "tokens": [
    {
      "mint": "So11111111111111111111111111111111111111112",
      "decimals": 9,
      "symbol": "SOL"
    },
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "decimals": 6,
      "symbol": "USDC"
    }
  ]
}
```

---

## Venue API

### GET /venues

Get list of supported DEX venues.

**Response (200):**

```json
{
  "venues": [
    {
      "name": "Raydium",
      "id": "raydium",
      "enabled": true
    },
    {
      "name": "Orca",
      "id": "orca",
      "enabled": true
    },
    {
      "name": "Phoenix",
      "id": "phoenix",
      "enabled": true
    },
    {
      "name": "Lifinity",
      "id": "lifinity",
      "enabled": true
    }
  ]
}
```

---

## Prediction Market API

### GET /prediction-market-init

Initialize prediction market token for trading.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `marketMint` | string | Yes | Prediction market token mint |
| `userPublicKey` | string | Yes | User's wallet |

**Response (200):**

```json
{
  "transaction": "base64-init-transaction",
  "marketInfo": {
    "mint": "...",
    "series": "...",
    "event": "...",
    "outcome": "YES"
  }
}
```

---

## Priority Fee Options

```typescript
// Option 1: Auto
prioritizationFeeLamports: "auto"

// Option 2: Disabled
prioritizationFeeLamports: "disabled"

// Option 3: Priority level
prioritizationFeeLamports: {
  priorityLevel: "medium" | "high" | "veryHigh"
}

// Option 4: Exact lamports
prioritizationFeeLamports: 150000

// Option 5: Auto with multiplier and cap
prioritizationFeeLamports: {
  autoMultiplier: 1.5,
  maxLamports: 500000
}

// Option 6: Jito tip
prioritizationFeeLamports: {
  jitoTipLamports: 10000
}
```

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request - invalid parameters |
| 401 | Unauthorized - invalid/missing API key |
| 404 | Not found - order/resource doesn't exist |
| 429 | Rate limited |
| 500 | Internal server error |
| 503 | Service unavailable - system initializing |

---

## Rate Limits

Without API key: ~10 requests/minute
With API key: Higher limits (contact DFlow for specifics)

Production applications should always use an API key.
