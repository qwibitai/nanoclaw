---
name: dflow
description: Complete DFlow trading protocol SDK - the single source of truth for integrating DFlow on Solana. Covers spot trading, prediction markets, Swap API, Metadata API, WebSocket streaming, and all DFlow tools.
---

# DFlow - Complete Integration Guide

The definitive guide for integrating DFlow - a trading protocol that enables traders to exchange value across spot and prediction markets natively on Solana.

## What is DFlow?

DFlow is a comprehensive trading infrastructure that provides:

- **Trading Applications & Wallets** - Token swaps with intelligent routing and 99.9% token coverage
- **Exchanges & Aggregators** - Access to billions in monthly routed volume across DEXes and Prop AMMs
- **Financial Institutions & Market Makers** - Programmable execution layers with CLPs and async trades
- **Prediction Market Platforms** - Discovery, pricing, routing, and settlement infrastructure

### Key Capabilities

| Feature | Description |
|---------|-------------|
| Token Coverage | 99.9% with millisecond detection |
| Infrastructure | Globally distributed, high-throughput optimization |
| Execution | Advanced algorithms with JIT routing for best-price execution |
| Markets | Support for both spot and prediction market trading |
| MEV Protection | Enhanced sandwich protection with Jito bundles |

## API Overview

DFlow provides two main API categories:

### 1. Swap API (Trading)
**Base URL:** `https://quote-api.dflow.net`

For executing trades:
- **Imperative Swaps** - Full control over route selection at signature time
- **Declarative Swaps** - Intent-based swaps with deferred route optimization
- **Trade API** - Unified interface for spot and prediction market trading
- **Order API** - Quote and transaction generation

### 2. Prediction Market Metadata API
**Base URL:** `https://api.prod.dflow.net`

For querying prediction market data:
- **Events API** - Query prediction events and forecasts
- **Markets API** - Get market details, orderbooks, outcome mints
- **Trades API** - Historical trade data
- **Live Data API** - Real-time milestones and updates
- **WebSocket** - Streaming price and orderbook updates

### Authentication
Most endpoints require an API key via the `x-api-key` header. Contact `hello@dflow.net` to obtain credentials.

## Quick Start

### Imperative Swap (3 Steps)

```typescript
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

const API_BASE = "https://quote-api.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY; // Optional but recommended

// Token addresses
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function imperativeSwap(keypair: Keypair, connection: Connection) {
  // Step 1: Get Quote
  const quoteParams = new URLSearchParams({
    inputMint: SOL,
    outputMint: USDC,
    amount: "1000000000", // 1 SOL
    slippageBps: "50",    // 0.5%
  });

  const quote = await fetch(`${API_BASE}/quote?${quoteParams}`, {
    headers: API_KEY ? { "x-api-key": API_KEY } : {},
  }).then(r => r.json());

  // Step 2: Get Swap Transaction
  const swapResponse = await fetch(`${API_BASE}/swap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY && { "x-api-key": API_KEY }),
    },
    body: JSON.stringify({
      userPublicKey: keypair.publicKey.toBase58(),
      quoteResponse: quote,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 150000,
    }),
  }).then(r => r.json());

  // Step 3: Sign and Send
  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapResponse.swapTransaction, "base64")
  );
  tx.sign([keypair]);

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(signature);

  return signature;
}
```

### Trade API (Unified - Recommended)

The Trade API provides a single endpoint that handles both sync and async execution:

```typescript
async function tradeTokens(keypair: Keypair, connection: Connection) {
  // Step 1: Get Order (quote + transaction in one call)
  const orderParams = new URLSearchParams({
    inputMint: SOL,
    outputMint: USDC,
    amount: "1000000000",
    slippageBps: "50",
    userPublicKey: keypair.publicKey.toBase58(),
  });

  const order = await fetch(`${API_BASE}/order?${orderParams}`, {
    headers: API_KEY ? { "x-api-key": API_KEY } : {},
  }).then(r => r.json());

  // Step 2: Sign and Send
  const tx = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64")
  );
  tx.sign([keypair]);
  const signature = await connection.sendTransaction(tx);

  // Step 3: Monitor (based on execution mode)
  if (order.executionMode === "async") {
    // Poll order status for async trades
    let status = "pending";
    while (status !== "closed" && status !== "failed") {
      await new Promise(r => setTimeout(r, 2000));
      const statusRes = await fetch(
        `${API_BASE}/order-status?signature=${signature}`,
        { headers: API_KEY ? { "x-api-key": API_KEY } : {} }
      ).then(r => r.json());
      status = statusRes.status;
    }
  } else {
    // Sync trades complete atomically
    await connection.confirmTransaction(signature);
  }

  return signature;
}
```

## API Reference

### Order API Endpoints

#### GET /order
Returns a quote and optionally a transaction for spot or prediction market trades.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `inputMint` | Yes | Base58 input token mint |
| `outputMint` | Yes | Base58 output token mint |
| `amount` | Yes | Amount as scaled integer (1 SOL = 1000000000) |
| `userPublicKey` | No | Include to receive signable transaction |
| `slippageBps` | No | Max slippage in basis points or "auto" |
| `platformFeeBps` | No | Platform fee in basis points |
| `prioritizationFeeLamports` | No | "auto", "medium", "high", "veryHigh", or lamport amount |

**Response:**
```json
{
  "outAmount": "150000000",
  "minOutAmount": "149250000",
  "priceImpactPct": "0.05",
  "executionMode": "sync",
  "transaction": "base64...",
  "computeUnitLimit": 200000,
  "lastValidBlockHeight": 123456789,
  "routePlan": [...]
}
```

#### GET /order-status
Check status of async orders.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `signature` | Yes | Base58 transaction signature |
| `lastValidBlockHeight` | No | Block height for expiry check |

**Status Values:**
- `pending` - Order submitted, awaiting processing
- `open` - Order opened, awaiting fill
- `pendingClose` - Filled, closing transaction pending
- `closed` - Order completed successfully
- `expired` - Transaction expired before landing
- `failed` - Order execution failed

### Imperative Swap Endpoints

#### GET /quote
Get a quote for an imperative swap.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `inputMint` | Yes | Base58 input mint |
| `outputMint` | Yes | Base58 output mint |
| `amount` | Yes | Input amount (scaled integer) |
| `slippageBps` | No | Slippage tolerance or "auto" |
| `dexes` | No | Comma-separated DEXes to include |
| `excludeDexes` | No | Comma-separated DEXes to exclude |
| `onlyDirectRoutes` | No | Single-leg routes only |
| `maxRouteLength` | No | Max number of route legs |
| `forJitoBundle` | No | Jito bundle compatible routes |
| `platformFeeBps` | No | Platform fee in basis points |

#### POST /swap
Generate swap transaction from quote.

**Request Body:**
```json
{
  "userPublicKey": "Base58...",
  "quoteResponse": { /* from /quote */ },
  "dynamicComputeUnitLimit": true,
  "prioritizationFeeLamports": 150000,
  "wrapAndUnwrapSol": true
}
```

**Response:**
```json
{
  "swapTransaction": "base64...",
  "computeUnitLimit": 200000,
  "lastValidBlockHeight": 123456789,
  "prioritizationFeeLamports": 150000
}
```

#### POST /swap-instructions
Returns individual instructions instead of a full transaction (for custom transaction building).

### Declarative Swap Endpoints

Declarative swaps use intent-based execution with deferred route optimization.

#### GET /intent
Get an intent quote for a declarative swap.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `inputMint` | Yes | Base58 input mint |
| `outputMint` | Yes | Base58 output mint |
| `amount` | Yes | Input amount (scaled integer) |
| `slippageBps` | No | Slippage tolerance |
| `userPublicKey` | Yes | User's wallet address |

#### POST /submit-intent
Submit a signed intent transaction for execution.

**Request Body:**
```json
{
  "signedTransaction": "base64...",
  "intentResponse": { /* from /intent */ }
}
```

### Token API Endpoints

#### GET /tokens
Returns list of supported token mints.

#### GET /tokens-with-decimals
Returns tokens with decimal information for proper amount scaling.

### Venue API Endpoints

#### GET /venues
Returns list of supported DEX venues (Raydium, Orca, Phoenix, Lifinity, etc.).

## Swap Modes Comparison

| Feature | Imperative | Declarative |
|---------|------------|-------------|
| Route Control | Full control at sign time | Optimized at execution |
| Latency | Higher (two API calls) | Lower (deferred calc) |
| Slippage | Fixed at quote time | Minimized at execution |
| Sandwich Protection | Standard | Enhanced |
| Use Case | Precise route requirements | Best execution priority |

### When to Use Imperative
- Need to review exact route before signing
- Building order books or specific DEX routing
- Complex multi-step transactions
- Need deterministic execution paths

### When to Use Declarative
- Prioritize best execution
- Lower slippage requirements
- Simple token swaps
- MEV protection is important

## Execution Modes

### Synchronous (Atomic)
- Single transaction execution
- All-or-nothing settlement
- Standard confirmation flow
- Use `connection.confirmTransaction()`

### Asynchronous (Multi-Transaction)
- Uses Jito bundles
- Open → Fill → Close transaction flow
- Poll `/order-status` for completion
- Better for complex routes or prediction markets

```typescript
// Async order monitoring
async function monitorAsyncOrder(signature: string) {
  const statuses = ["pending", "open", "pendingClose"];
  let currentStatus = "pending";

  while (statuses.includes(currentStatus)) {
    await new Promise(r => setTimeout(r, 2000));

    const res = await fetch(
      `${API_BASE}/order-status?signature=${signature}`,
      { headers: { "x-api-key": API_KEY } }
    ).then(r => r.json());

    currentStatus = res.status;

    if (currentStatus === "closed") {
      return { success: true, fills: res.fills };
    }
    if (currentStatus === "failed" || currentStatus === "expired") {
      return { success: false, status: currentStatus };
    }
  }
}
```

## Prediction Markets

DFlow provides infrastructure for trading prediction market outcome tokens.

### Market Structure
```
Series (Collection)
  └── Event (Occurrence)
        └── Market (Outcome Trade)
```

### Market Lifecycle
1. **Initialized** - Market created
2. **Active** - Trading enabled
3. **Inactive** - Trading paused
4. **Closed** - No more trading
5. **Determined** - Outcome known
6. **Finalized** - Payouts available

### Trading Prediction Markets
```typescript
// Use the Trade API with prediction market token mints
const order = await fetch(`${API_BASE}/order?${new URLSearchParams({
  inputMint: USDC,
  outputMint: OUTCOME_TOKEN_MINT, // Prediction market token
  amount: "10000000", // 10 USDC
  slippageBps: "100",
  userPublicKey: keypair.publicKey.toBase58(),
  predictionMarketSlippageBps: "200", // Separate slippage for PM
})}`, { headers: { "x-api-key": API_KEY } }).then(r => r.json());
```

## Common Token Mints

| Token | Mint Address |
|-------|--------------|
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |

## Priority Fees

Configure transaction priority:

```typescript
// Option 1: Auto (recommended)
prioritizationFeeLamports: "auto"

// Option 2: Priority level
prioritizationFeeLamports: {
  priorityLevel: "high" // "medium", "high", "veryHigh"
}

// Option 3: Exact amount
prioritizationFeeLamports: 150000

// Option 4: Max with auto-adjust
prioritizationFeeLamports: {
  autoMultiplier: 2,
  maxLamports: 500000
}
```

## Error Handling

```typescript
async function safeSwap(params: SwapParams) {
  try {
    const quote = await getQuote(params);

    if (!quote.routePlan?.length) {
      throw new Error("No route found");
    }

    const swap = await getSwapTransaction(quote, params.userPublicKey);
    const tx = deserializeTransaction(swap.swapTransaction);
    tx.sign([params.keypair]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    return { success: true, signature };
  } catch (error) {
    if (error.message.includes("insufficient")) {
      return { success: false, error: "Insufficient balance" };
    }
    if (error.message.includes("slippage")) {
      return { success: false, error: "Slippage exceeded" };
    }
    return { success: false, error: error.message };
  }
}
```

## Platform Fees

Collect platform fees on swaps:

```typescript
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  platformFeeBps: "50", // 0.5% fee
  platformFeeMode: "outputMint", // Collect in output token
})}`, { headers: { "x-api-key": API_KEY } }).then(r => r.json());

// In swap request, specify fee account
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": API_KEY },
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    feeAccount: platformFeeAccount.toBase58(), // Your fee recipient
  }),
}).then(r => r.json());
```

## Jito Integration

For MEV protection and bundle submission:

```typescript
// Request Jito-compatible routes
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  forJitoBundle: "true",
})}`, { headers: { "x-api-key": API_KEY } }).then(r => r.json());

// Include Jito sandwich mitigation
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    includeJitoSandwichMitigationAccount: true,
  }),
}).then(r => r.json());
```

## DFlow Swap Orchestrator

The DFlow Swap Orchestrator contract manages declarative swap execution:
```
Program ID: DF1ow3DqMj3HvTj8i8J9yM2hE9hCrLLXpdbaKZu4ZPnz
```

---

## Prediction Market Metadata API

The Prediction Market Metadata API provides comprehensive access to prediction market information.

**Base URL:** `https://api.prod.dflow.net`

### Market Structure

```
Series (Collection)
  └── Event (Occurrence)
        └── Market (Outcome Trade)
              ├── Yes Token (outcome mint)
              └── No Token (outcome mint)
```

### Events API

#### GET /api/v1/event/{ticker}
Returns a single event by its ticker with optional nested markets.

```typescript
const METADATA_API = "https://api.prod.dflow.net";

// Get event details
const event = await fetch(`${METADATA_API}/api/v1/event/TRUMP-2024`, {
  headers: { "x-api-key": API_KEY }
}).then(r => r.json());

// Response includes: ticker, title, status, markets, close_time, etc.
```

#### GET /api/v1/events
Returns a paginated list of all events.

```typescript
const events = await fetch(`${METADATA_API}/api/v1/events?limit=50&offset=0`, {
  headers: { "x-api-key": API_KEY }
}).then(r => r.json());
```

#### GET /api/v1/event/{ticker}/forecast
Returns historical forecast percentile data.

#### GET /api/v1/event/{ticker}/candlesticks
Returns candlestick data from Kalshi.

### Markets API

#### GET /api/v1/market/{ticker}
Returns a single market by ticker.

```typescript
const market = await fetch(`${METADATA_API}/api/v1/market/TRUMP-2024-WIN`, {
  headers: { "x-api-key": API_KEY }
}).then(r => r.json());

// Response: ticker, yes_mint, no_mint, status, last_price, volume, etc.
```

#### GET /api/v1/market/by-mint/{mint_address}
Lookup market by any mint (ledger or outcome mints).

```typescript
const market = await fetch(
  `${METADATA_API}/api/v1/market/by-mint/${outcomeMint}`,
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());
```

#### POST /api/v1/markets/batch
Batch retrieve multiple markets (max 100).

```typescript
const markets = await fetch(`${METADATA_API}/api/v1/markets/batch`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": API_KEY },
  body: JSON.stringify({
    tickers: ["MARKET-1", "MARKET-2"],
    mints: ["mint1...", "mint2..."]
  })
}).then(r => r.json());
```

#### GET /api/v1/outcome_mints
Returns all yes_mint and no_mint pubkeys from all supported markets.

```typescript
// Get all outcome mints, optionally filter by close time
const mints = await fetch(
  `${METADATA_API}/api/v1/outcome_mints?min_close_timestamp=${Date.now()}`,
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());
```

#### POST /api/v1/filter_outcome_mints
Check if addresses are outcome mints (max 200).

```typescript
const filtered = await fetch(`${METADATA_API}/api/v1/filter_outcome_mints`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": API_KEY },
  body: JSON.stringify({ addresses: ["mint1...", "mint2..."] })
}).then(r => r.json());
```

### Orderbook API

#### GET /api/v1/orderbook/{ticker}
Get orderbook by market ticker.

```typescript
const orderbook = await fetch(
  `${METADATA_API}/api/v1/orderbook/TRUMP-2024-WIN`,
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());

// Response: bids: [{price, quantity}], asks: [{price, quantity}]
```

#### GET /api/v1/orderbook/by-mint/{mint_address}
Get orderbook using mint address lookup.

### Trades API

#### GET /api/v1/trades
Returns paginated trade history with filtering.

```typescript
const trades = await fetch(
  `${METADATA_API}/api/v1/trades?ticker=TRUMP-2024-WIN&limit=100`,
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());
```

#### GET /api/v1/trades/by-mint/{mint_address}
Get trades using mint address lookup.

### Live Data API

#### GET /api/v1/milestones/{ticker}
Real-time milestone data from Kalshi.

```typescript
const milestones = await fetch(
  `${METADATA_API}/api/v1/milestones/TRUMP-2024`,
  { headers: { "x-api-key": API_KEY } }
).then(r => r.json());
```

### Series & Categories

#### GET /api/v1/series
Returns series templates for recurring events.

#### GET /api/v1/categories
Returns category tags for filtering.

### WebSocket Streaming

Connect for real-time updates:

```typescript
const ws = new WebSocket("wss://api.prod.dflow.net/ws");

ws.onopen = () => {
  // Subscribe to market updates
  ws.send(JSON.stringify({
    action: "subscribe",
    channel: "market",
    ticker: "TRUMP-2024-WIN"
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle: price_update, orderbook_update, trade, etc.
  console.log("Update:", data);
};
```

### Market Lifecycle

| Status | Description |
|--------|-------------|
| `initialized` | Market created |
| `active` | Trading enabled |
| `inactive` | Trading paused |
| `closed` | No more trading |
| `determined` | Outcome known |
| `finalized` | Payouts available |

---

## GitHub Tools & SDKs

DFlow provides several open-source tools on GitHub:

### solana-agent-kit
**Repository:** [DFlowProtocol/solana-agent-kit](https://github.com/DFlowProtocol/solana-agent-kit)

Toolkit enabling AI agents to connect to Solana protocols:

```typescript
// Use with AI agents for automated trading
import { SolanaAgentKit } from "@dflow/solana-agent-kit";

const agent = new SolanaAgentKit({
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.PRIVATE_KEY,
});

// Agent can execute DFlow swaps, query markets, etc.
```

### clearpools
**Repository:** [DFlowProtocol/clearpools](https://github.com/DFlowProtocol/clearpools)

Orca Whirlpools with support for flow segmentation:

```typescript
// Extends Orca protocol with DFlow routing
import { ClearPools } from "@dflow/clearpools";

const pools = new ClearPools(connection);
await pools.initializePool(/* params */);
```

### dflow-amm-interface
**Repository:** [DFlowProtocol/dflow-amm-interface](https://github.com/DFlowProtocol/dflow-amm-interface)

Rust trait definitions for DFlow's AMM implementation. Use when building custom AMMs that integrate with DFlow routing.

### Infrastructure Tools
- **solana-accountsdb-plugin-bigtable** - Geyser plugin for Bigtable
- **solana-bigtable-connection** - Bigtable connection library
- **solana-bigtable-geyser-models** - Object models for Geyser data

---

## Skill Structure

```
dflow/
├── SKILL.md                           # This file - complete integration guide
├── resources/
│   ├── api-reference.md               # Swap API reference
│   ├── prediction-market-api.md       # Prediction Market Metadata API reference
│   ├── github-sdks.md                 # GitHub tools & SDKs documentation
│   ├── token-mints.md                 # Common token addresses
│   └── error-codes.md                 # Error handling guide
├── examples/
│   ├── imperative-swaps/              # Imperative swap examples
│   ├── declarative-swaps/             # Declarative swap examples
│   ├── trade-api/                     # Unified Trade API examples
│   └── prediction-markets/            # Prediction market examples
│       ├── query-markets.ts           # Query events, markets, orderbook
│       ├── trade-outcomes.ts          # Trade outcome tokens
│       └── websocket-client.ts        # Real-time data streaming
├── templates/
│   ├── swap-client.ts                 # Swap client starter
│   └── prediction-market-client.ts    # Prediction market client starter
└── docs/
    ├── advanced-patterns.md           # Complex integrations
    └── troubleshooting.md             # Common issues
```

## Guidelines

1. **Use Trade API for most cases** - Unified endpoint handles both sync/async
2. **Always handle async orders** - Check `executionMode` and poll status
3. **Set appropriate slippage** - "auto" for convenience, custom for control
4. **Include priority fees** - Essential for reliable execution
5. **Handle errors gracefully** - Network issues, slippage, insufficient balance
6. **Monitor rate limits** - Use API key for production
7. **Test on devnet first** - DFlow supports Solana devnet

## Resources

- [DFlow Documentation](https://pond.dflow.net)
- [API Keys](mailto:hello@dflow.net)
- [Discord Community](https://discord.gg/dflow)
- [GitHub](https://github.com/dflow-protocol)
