---
name: helius
description: Comprehensive guide for Helius - Solana's leading RPC and API infrastructure provider. Covers RPC nodes, DAS (Digital Asset Standard) API, Enhanced Transactions, Priority Fees, Webhooks, ZK Compression, LaserStream gRPC, and the Helius SDK for building high-performance Solana applications
---

# Helius Development Guide

Build high-performance Solana applications with Helius - the leading RPC and API infrastructure provider with 99.99% uptime, global edge nodes, and developer-first APIs.

## Overview

Helius provides:
- **RPC Infrastructure**: Globally distributed nodes with ultra-low latency
- **DAS API**: Unified NFT and token data (compressed & standard)
- **Enhanced Transactions**: Parsed, human-readable transaction data
- **Priority Fee API**: Real-time fee recommendations
- **Webhooks**: Event-driven blockchain monitoring
- **ZK Compression**: Compressed account and token APIs
- **LaserStream**: gRPC-based real-time data streaming
- **Sender API**: Optimized transaction landing

## Quick Start

### Installation

```bash
# Install Helius SDK
npm install helius-sdk

# Or with pnpm (recommended)
pnpm add helius-sdk
```

### Get Your API Key

1. Visit [dashboard.helius.dev](https://dashboard.helius.dev)
2. Create an account or sign in
3. Generate an API key
4. Store it securely (never commit to git)

### Environment Setup

```bash
# .env file
HELIUS_API_KEY=your_api_key_here
```

### Basic Setup

```typescript
import { createHelius } from "helius-sdk";

const helius = createHelius({
  apiKey: process.env.HELIUS_API_KEY!,
});

// RPC endpoint URLs
const MAINNET_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const DEVNET_RPC = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
```

## RPC Infrastructure

### Endpoints

| Network | HTTP Endpoint | WebSocket Endpoint |
|---------|--------------|-------------------|
| Mainnet | `https://mainnet.helius-rpc.com/?api-key=<KEY>` | `wss://mainnet.helius-rpc.com/?api-key=<KEY>` |
| Devnet | `https://devnet.helius-rpc.com/?api-key=<KEY>` | `wss://devnet.helius-rpc.com/?api-key=<KEY>` |

### Using with @solana/kit

```typescript
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const rpc = createSolanaRpc(
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
);

const rpcSubscriptions = createSolanaRpcSubscriptions(
  `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
);

// Make RPC calls
const slot = await rpc.getSlot().send();
const balance = await rpc.getBalance(address).send();
```

### Helius-Exclusive RPC Methods

| Method | Description |
|--------|-------------|
| `getProgramAccountsV2` | Cursor-based pagination for program accounts |
| `getTokenAccountsByOwnerV2` | Efficient token account retrieval |
| `getTransactionsForAddress` | Advanced transaction history with filtering |

```typescript
// getProgramAccountsV2 - handles large datasets efficiently
const accounts = await helius.rpc.getProgramAccountsV2({
  programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  cursor: null, // Start from beginning
  limit: 100,
});

// getTransactionsForAddress - advanced filtering
const transactions = await helius.rpc.getTransactionsForAddress({
  address: "wallet_address",
  before: null,
  until: null,
  limit: 100,
  source: "JUPITER", // Filter by source
  type: "SWAP", // Filter by type
});
```

## DAS API (Digital Asset Standard)

Unified access to NFTs, tokens, and compressed assets.

### Core Methods

```typescript
// Get single asset
const asset = await helius.getAsset({
  id: "asset_id_here",
});

// Get assets by owner
const assets = await helius.getAssetsByOwner({
  ownerAddress: "wallet_address",
  page: 1,
  limit: 100,
  displayOptions: {
    showFungible: true,
    showNativeBalance: true,
  },
});

// Get assets by collection
const collection = await helius.getAssetsByGroup({
  groupKey: "collection",
  groupValue: "collection_address",
  page: 1,
  limit: 100,
});

// Search assets with filters
const results = await helius.searchAssets({
  ownerAddress: "wallet_address",
  tokenType: "fungible",
  burnt: false,
  page: 1,
  limit: 50,
});

// Get batch of assets
const batch = await helius.getAssetBatch({
  ids: ["asset1", "asset2", "asset3"],
});

// Get asset proof (for compressed NFTs)
const proof = await helius.getAssetProof({
  id: "compressed_nft_id",
});
```

### DAS Method Reference

| Method | Description |
|--------|-------------|
| `getAsset` | Get single asset by ID |
| `getAssetBatch` | Get multiple assets |
| `getAssetProof` | Get merkle proof for cNFT |
| `getAssetProofBatch` | Get multiple proofs |
| `getAssetsByOwner` | All assets for wallet |
| `getAssetsByCreator` | Assets by creator address |
| `getAssetsByAuthority` | Assets by authority |
| `getAssetsByGroup` | Assets by collection/group |
| `searchAssets` | Advanced search with filters |
| `getNftEditions` | Get NFT edition info |
| `getTokenAccounts` | Get token accounts |
| `getSignaturesForAsset` | Transaction history for asset |

## Enhanced Transactions API

Get parsed, human-readable transaction data.

```typescript
// Parse transactions by signature
const parsed = await helius.enhanced.getTransactions({
  transactions: ["sig1", "sig2", "sig3"],
});

// Get enhanced transaction history
const history = await helius.enhanced.getTransactionsByAddress({
  address: "wallet_address",
  type: "SWAP", // Optional: filter by type
});
```

### Transaction Types

- `SWAP` - DEX swaps (Jupiter, Raydium, Orca)
- `NFT_SALE` - NFT marketplace sales
- `NFT_LISTING` - NFT listings
- `NFT_BID` - NFT bids
- `TOKEN_MINT` - Token minting
- `TRANSFER` - SOL/token transfers
- `STAKE` - Staking operations
- `UNKNOWN` - Unrecognized transactions

## Priority Fee API

Get real-time priority fee recommendations.

```typescript
// Get priority fee estimate
const feeEstimate = await helius.getPriorityFeeEstimate({
  transaction: serializedTransaction, // Base64 encoded
  // OR
  accountKeys: ["account1", "account2"], // Accounts in transaction
  options: {
    priorityLevel: "HIGH", // LOW, MEDIUM, HIGH, VERY_HIGH
    includeAllPriorityFeeLevels: true,
    lookbackSlots: 150,
  },
});

console.log(feeEstimate.priorityFeeEstimate); // microLamports
```

### Using Priority Fees in Transactions

```typescript
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";

// Get estimate
const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
  accountKeys: [payer.address, recipient.address],
  options: { priorityLevel: "HIGH" },
});

// Add to transaction
const priorityFeeIx = getSetComputeUnitPriceInstruction({
  microLamports: BigInt(priorityFeeEstimate),
});

// Prepend to transaction instructions
const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(payer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => prependTransactionMessageInstructions([priorityFeeIx], tx),
  (tx) => appendTransactionMessageInstruction(mainInstruction, tx),
);
```

## Webhooks

Real-time blockchain event notifications.

### Webhook Types

| Type | Description |
|------|-------------|
| **Enhanced** | Parsed, filtered events (NFT sales, swaps, etc.) |
| **Raw** | Unfiltered transaction data, lower latency |
| **Discord** | Direct Discord channel notifications |

### Create Webhook

```typescript
// Create enhanced webhook
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/webhook",
  transactionTypes: ["NFT_SALE", "SWAP"],
  accountAddresses: ["address1", "address2"],
  webhookType: "enhanced",
});

// Create raw webhook
const rawWebhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/raw-webhook",
  accountAddresses: ["address1"],
  webhookType: "raw",
});
```

### Manage Webhooks

```typescript
// Get all webhooks
const webhooks = await helius.webhooks.getAllWebhooks();

// Get specific webhook
const webhook = await helius.webhooks.getWebhookByID({
  webhookID: "webhook_id",
});

// Update webhook
await helius.webhooks.updateWebhook({
  webhookID: "webhook_id",
  webhookURL: "https://new-url.com/webhook",
  accountAddresses: ["address1", "address2", "address3"],
});

// Delete webhook
await helius.webhooks.deleteWebhook({
  webhookID: "webhook_id",
});
```

### Webhook Payload (Enhanced)

```typescript
interface EnhancedWebhookPayload {
  accountData: AccountData[];
  description: string;
  events: Record<string, unknown>;
  fee: number;
  feePayer: string;
  nativeTransfers: NativeTransfer[];
  signature: string;
  slot: number;
  source: string;
  timestamp: number;
  tokenTransfers: TokenTransfer[];
  type: string;
}
```

## ZK Compression API

Work with compressed accounts and tokens (Light Protocol).

```typescript
// Get compressed account
const account = await helius.zk.getCompressedAccount({
  address: "compressed_account_address",
});

// Get compressed token accounts by owner
const tokens = await helius.zk.getCompressedTokenAccountsByOwner({
  owner: "wallet_address",
});

// Get compressed balance
const balance = await helius.zk.getCompressedBalance({
  address: "compressed_account_address",
});

// Get validity proof
const proof = await helius.zk.getValidityProof({
  hashes: ["hash1", "hash2"],
});

// Get compression signatures
const sigs = await helius.zk.getCompressionSignaturesForOwner({
  owner: "wallet_address",
  limit: 100,
});
```

### ZK Compression Methods

| Method | Description |
|--------|-------------|
| `getCompressedAccount` | Get compressed account data |
| `getCompressedAccountProof` | Get proof for account |
| `getCompressedAccountsByOwner` | All compressed accounts for wallet |
| `getCompressedBalance` | Get compressed SOL balance |
| `getCompressedTokenAccountsByOwner` | Compressed token accounts |
| `getCompressedTokenBalancesByOwner` | Token balances |
| `getValidityProof` | Get validity proof for hashes |
| `getCompressionSignaturesForOwner` | Compression transaction history |
| `getIndexerHealth` | Check indexer status |
| `getIndexerSlot` | Current indexed slot |

## Transaction Sending

### Smart Transaction Sending

```typescript
// Send with automatic retry and optimization
const signature = await helius.tx.sendSmartTransaction({
  transaction: signedTransaction,
  skipPreflight: false,
  maxRetries: 3,
});

// Estimate compute units
const computeUnits = await helius.tx.getComputeUnits({
  transaction: serializedTransaction,
});
```

### Optimized Transaction Pattern

```typescript
import { createHelius } from "helius-sdk";
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

async function sendOptimizedTransaction(
  helius: ReturnType<typeof createHelius>,
  rpc: Rpc,
  signer: KeyPairSigner,
  instruction: IInstruction
) {
  // 1. Get priority fee
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys: [signer.address],
    options: { priorityLevel: "HIGH" },
  });

  // 2. Get blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // 3. Build transaction with compute budget
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) => prependTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: BigInt(priorityFeeEstimate) }),
    ], tx),
    (tx) => appendTransactionMessageInstruction(instruction, tx),
  );

  // 4. Sign
  const signedTx = await signTransactionMessageWithSigners(tx);

  // 5. Send via Helius
  const signature = await helius.tx.sendSmartTransaction({
    transaction: getBase64EncodedWireTransaction(signedTx),
  });

  return signature;
}
```

## WebSocket Subscriptions

Real-time data streaming via WebSocket.

```typescript
// Subscribe to account changes
const accountSub = await helius.ws.accountNotifications({
  account: "account_address",
  commitment: "confirmed",
  callback: (notification) => {
    console.log("Account changed:", notification);
  },
});

// Subscribe to logs
const logsSub = await helius.ws.logsNotifications({
  filter: { mentions: ["program_id"] },
  commitment: "confirmed",
  callback: (logs) => {
    console.log("Logs:", logs);
  },
});

// Subscribe to signature confirmations
const sigSub = await helius.ws.signatureNotifications({
  signature: "transaction_signature",
  commitment: "confirmed",
  callback: (status) => {
    console.log("Confirmed:", status);
  },
});

// Unsubscribe
await accountSub.unsubscribe();
```

## LaserStream (gRPC)

LaserStream is a next-generation gRPC streaming service - a drop-in replacement for Yellowstone that adds historical replay, auto-reconnect, and multi-region endpoints.

### Features
- **Ultra-low latency**: Taps directly into Solana leaders to receive shreds as they're produced
- **Historical replay**: Replay past blocks and transactions
- **Auto-reconnect**: Automatic failover and recovery
- **Redundant node clusters**: High availability infrastructure
- **Regional endpoints**: Global coverage for minimal latency
- Block, transaction, and account streaming

### Endpoints

| Region | Endpoint |
|--------|----------|
| Frankfurt | `fra.laserstream.helius.dev` |
| Amsterdam | `ams.laserstream.helius.dev` |
| Tokyo | `tyo.laserstream.helius.dev` |
| Singapore | `sg.laserstream.helius.dev` |
| Los Angeles | `lax.laserstream.helius.dev` |
| London | `lon.laserstream.helius.dev` |
| Newark | `ewr.laserstream.helius.dev` |
| Pittsburgh | `pitt.laserstream.helius.dev` |
| Salt Lake City | `slc.laserstream.helius.dev` |

### Atlas Infrastructure

Atlas endpoints provide the backbone for Enhanced WebSockets and high-performance streaming:

```typescript
// Atlas WebSocket endpoints
const ATLAS_MAINNET_WS = "wss://atlas-mainnet.helius-rpc.com";
const ATLAS_DEVNET_WS = "wss://atlas-devnet.helius-rpc.com";
```

### Enhanced WebSockets (New)

Enhanced WebSockets are now powered by LaserStream infrastructure, offering:
- **1.5–2× faster** than standard WebSockets
- gRPC reliability in a WebSocket wrapper
- Same filtering and event types as regular WebSockets

```typescript
// Connect to Enhanced WebSocket
const ws = new WebSocket(
  `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
);

ws.on("open", () => {
  // Subscribe to account changes
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "accountSubscribe",
    params: [accountAddress, { commitment: "confirmed" }],
  }));
});
```

### Shred Delivery (Beta)

For teams chasing single-digit millisecond latency, Helius offers a UDP feed of raw shreds directly from validators.

## Staking API

Stake SOL with Helius validator programmatically.

```typescript
// Create stake transaction
const stakeTx = await helius.staking.createStakeTransaction({
  payerAddress: "wallet_address",
  amount: 1_000_000_000, // 1 SOL in lamports
});

// Create unstake transaction
const unstakeTx = await helius.staking.createUnstakeTransaction({
  payerAddress: "wallet_address",
  stakeAccountAddress: "stake_account",
});

// Get stake accounts
const stakeAccounts = await helius.staking.getHeliusStakeAccounts({
  ownerAddress: "wallet_address",
});
```

## SDK Namespaces

| Namespace | Purpose |
|-----------|---------|
| `helius.*` | DAS API, priority fees |
| `helius.rpc.*` | Enhanced RPC methods |
| `helius.tx.*` | Transaction operations |
| `helius.staking.*` | Validator staking |
| `helius.enhanced.*` | Decoded transaction data |
| `helius.webhooks.*` | Event management |
| `helius.ws.*` | WebSocket subscriptions |
| `helius.zk.*` | ZK Compression features |

## Error Handling

```typescript
try {
  const assets = await helius.getAssetsByOwner({ ownerAddress: "..." });
} catch (error) {
  if (error.response?.status === 401) {
    console.error("Invalid API key");
  } else if (error.response?.status === 429) {
    console.error("Rate limited - upgrade plan or reduce requests");
  } else if (error.response?.status >= 500) {
    console.error("Helius server error - retry later");
  }
}
```

### Common Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| 401 | Invalid API key | Check key in dashboard |
| 429 | Rate limited | Upgrade plan or add delays |
| 500+ | Server error | Retry with backoff |

## Rate Limits & Pricing

| Plan | Credits/Month | RPC Calls | Webhooks |
|------|--------------|-----------|----------|
| Free | 500,000 | Standard | 2 |
| Developer | 5M | Enhanced | 10 |
| Growth | 50M | Priority | 50 |
| Enterprise | Custom | Dedicated | Unlimited |

### Credit Costs

- Standard RPC: 1 credit/call
- DAS API: 1-10 credits/call
- Webhooks: 1 credit/event delivered
- Webhook management: 100 credits/operation

## Best Practices

### API Key Security
- Never commit API keys to git
- Use environment variables
- Rotate keys periodically
- Use separate keys for dev/prod

### Performance
- Batch requests when possible (getAssetBatch, getAssetProofBatch)
- Use cursor-based pagination for large datasets
- Cache frequently accessed data
- Use appropriate commitment levels

### Reliability
- Implement retry logic with exponential backoff
- Handle rate limits gracefully
- Use multiple regional endpoints for failover
- Monitor webhook delivery and handle retries

## Resources

- [Helius Documentation](https://www.helius.dev/docs)
- [Helius Dashboard](https://dashboard.helius.dev)
- [Helius SDK GitHub](https://github.com/helius-labs/helius-sdk)
- [Helius Discord](https://discord.gg/helius)
- [Helius Status](https://status.helius.dev)

## Skill Structure

```
helius/
├── SKILL.md                    # This file
├── resources/
│   ├── rpc-methods.md          # Complete RPC reference
│   ├── das-api.md              # DAS API reference
│   ├── enhanced-apis.md        # Enhanced transactions & priority fees
│   ├── webhooks.md             # Webhook configuration
│   ├── zk-compression.md       # ZK compression API
│   └── sdk-reference.md        # SDK namespace reference
├── examples/
│   ├── basic-rpc/              # Basic RPC calls
│   ├── fetch-nfts/             # DAS API examples
│   ├── send-transactions/      # Transaction sending
│   ├── webhooks/               # Webhook setup
│   └── streaming/              # Real-time data
├── templates/
│   └── helius-setup.ts         # Starter template
└── docs/
    └── troubleshooting.md      # Common issues
```
