# Webhooks Reference

Complete reference for Helius Webhooks - real-time blockchain event notifications.

## Overview

Helius Webhooks deliver real-time notifications for on-chain events:
- Transaction monitoring
- NFT sales and listings
- Token transfers
- DeFi operations
- Account state changes

## Webhook Types

| Type | Description | Use Case |
|------|-------------|----------|
| **Enhanced** | Parsed, filtered events | Trading bots, analytics |
| **Raw** | Unfiltered transaction data | Low-latency indexing |
| **Discord** | Formatted Discord messages | Community notifications |

### Enhanced Webhooks

Deliver parsed, human-readable data filtered by transaction type.

```typescript
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/webhook",
  transactionTypes: ["NFT_SALE", "SWAP", "TOKEN_MINT"],
  accountAddresses: ["address1", "address2"],
  webhookType: "enhanced",
});
```

### Raw Webhooks

Stream unfiltered transaction data for monitored addresses.

```typescript
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/raw-webhook",
  accountAddresses: ["address1", "address2"],
  webhookType: "raw",
});
```

### Discord Webhooks

Send formatted notifications directly to Discord.

```typescript
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://discord.com/api/webhooks/...",
  transactionTypes: ["NFT_SALE"],
  accountAddresses: ["collection_address"],
  webhookType: "discord",
});
```

## Creating Webhooks

### Via SDK

```typescript
import { createHelius } from "helius-sdk";

const helius = createHelius({ apiKey: "your-api-key" });

const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/webhook",
  transactionTypes: ["SWAP", "NFT_SALE"],
  accountAddresses: [
    "wallet_address_1",
    "wallet_address_2",
  ],
  webhookType: "enhanced",
  authHeader: "Bearer your-auth-token", // Optional auth header
});

console.log("Webhook ID:", webhook.webhookID);
```

### Via REST API

```typescript
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks?api-key=${API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: "https://your-server.com/webhook",
      transactionTypes: ["SWAP", "NFT_SALE"],
      accountAddresses: ["address1", "address2"],
      webhookType: "enhanced",
    }),
  }
);

const webhook = await response.json();
```

## Managing Webhooks

### Get All Webhooks

```typescript
// Via SDK
const webhooks = await helius.webhooks.getAllWebhooks();

// Via REST
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks?api-key=${API_KEY}`
);
const webhooks = await response.json();
```

### Get Webhook by ID

```typescript
// Via SDK
const webhook = await helius.webhooks.getWebhookByID({
  webhookID: "webhook-id-here",
});

// Via REST
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${API_KEY}`
);
const webhook = await response.json();
```

### Update Webhook

```typescript
// Via SDK
await helius.webhooks.updateWebhook({
  webhookID: "webhook-id-here",
  webhookURL: "https://new-url.com/webhook",
  transactionTypes: ["SWAP", "NFT_SALE", "TRANSFER"],
  accountAddresses: ["address1", "address2", "address3"],
});

// Via REST
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${API_KEY}`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: "https://new-url.com/webhook",
      transactionTypes: ["SWAP", "NFT_SALE"],
      accountAddresses: ["address1", "address2"],
    }),
  }
);
```

### Delete Webhook

```typescript
// Via SDK
await helius.webhooks.deleteWebhook({
  webhookID: "webhook-id-here",
});

// Via REST
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${API_KEY}`,
  { method: "DELETE" }
);
```

## Transaction Types

Filter webhooks by transaction type:

| Type | Description |
|------|-------------|
| `TRANSFER` | SOL/token transfers |
| `SWAP` | DEX swaps |
| `NFT_SALE` | NFT marketplace sales |
| `NFT_LISTING` | NFT listed for sale |
| `NFT_CANCEL_LISTING` | Listing cancelled |
| `NFT_BID` | Bid placed |
| `NFT_BID_CANCELLED` | Bid cancelled |
| `NFT_MINT` | NFT minted |
| `TOKEN_MINT` | Token minted |
| `BURN` | Token/NFT burned |
| `STAKE` | SOL staked |
| `UNSTAKE` | SOL unstaked |
| `LOAN` | Lending loan created |
| `REPAY_LOAN` | Loan repaid |
| `ADD_TO_POOL` | Liquidity added |
| `REMOVE_FROM_POOL` | Liquidity removed |
| `COMPRESSED_NFT_MINT` | cNFT minted |
| `COMPRESSED_NFT_TRANSFER` | cNFT transferred |
| `COMPRESSED_NFT_BURN` | cNFT burned |

## Webhook Payload Structure

### Enhanced Webhook Payload

```typescript
interface EnhancedWebhookPayload {
  // Transaction metadata
  signature: string;
  slot: number;
  timestamp: number;
  fee: number;
  feePayer: string;
  type: string;
  source: string;
  description: string;

  // Native SOL transfers
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number; // lamports
  }>;

  // Token transfers
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;

  // Account data changes
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
    }>;
  }>;

  // Parsed events
  events: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
      tokenOutputs: Array<{...}>;
      tokenFees: Array<{...}>;
      nativeFees: Array<{...}>;
      innerSwaps: Array<{
        tokenInputs: Array<{...}>;
        tokenOutputs: Array<{...}>;
        tokenFees: Array<{...}>;
        nativeFees: Array<{...}>;
        programInfo: { source: string; account: string; ... };
      }>;
    };

    nft?: {
      description: string;
      type: string;
      source: string;
      amount: number;
      fee: number;
      feePayer: string;
      signature: string;
      slot: number;
      timestamp: number;
      saleType: string;
      buyer: string;
      seller: string;
      staker?: string;
      nfts: Array<{
        mint: string;
        tokenStandard: string;
      }>;
    };

    compressed?: Array<{
      type: string;
      treeId: string;
      leafIndex: number;
      seq: number;
      assetId: string;
      instructionIndex: number;
      innerInstructionIndex: number;
      newLeafOwner: string;
      oldLeafOwner?: string;
    }>;
  };

  // Raw instruction data
  instructions: Array<{
    accounts: string[];
    data: string;
    programId: string;
    innerInstructions: Array<{
      accounts: string[];
      data: string;
      programId: string;
    }>;
  }>;
}
```

### Raw Webhook Payload

```typescript
interface RawWebhookPayload {
  // Full transaction object as returned by getTransaction
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{
        pubkey: string;
        signer: boolean;
        source: string;
        writable: boolean;
      }>;
      instructions: Array<{
        accounts: number[];
        data: string;
        programIdIndex: number;
        stackHeight: number | null;
      }>;
      recentBlockhash: string;
    };
  };
  meta: {
    err: null | object;
    fee: number;
    innerInstructions: Array<{...}>;
    logMessages: string[];
    postBalances: number[];
    postTokenBalances: Array<{...}>;
    preBalances: number[];
    preTokenBalances: Array<{...}>;
    rewards: Array<{...}>;
    status: { Ok: null } | { Err: object };
  };
}
```

## Handling Webhooks

### Express.js Example

```typescript
import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

// Webhook endpoint
app.post("/webhook", (req, res) => {
  const payload = req.body;

  // Process based on type
  switch (payload.type) {
    case "SWAP":
      handleSwap(payload);
      break;
    case "NFT_SALE":
      handleNftSale(payload);
      break;
    case "TRANSFER":
      handleTransfer(payload);
      break;
    default:
      console.log("Unknown type:", payload.type);
  }

  // Always respond 200 to acknowledge receipt
  res.status(200).json({ received: true });
});

function handleSwap(payload: EnhancedWebhookPayload) {
  const { events, signature, timestamp } = payload;

  if (events.swap) {
    const { tokenInputs, tokenOutputs } = events.swap;
    console.log(`Swap detected: ${signature}`);
    console.log(`Input: ${tokenInputs[0]?.mint}`);
    console.log(`Output: ${tokenOutputs[0]?.mint}`);
  }
}

function handleNftSale(payload: EnhancedWebhookPayload) {
  const { events, signature } = payload;

  if (events.nft) {
    const { buyer, seller, amount, nfts } = events.nft;
    console.log(`NFT Sale: ${nfts[0]?.mint}`);
    console.log(`Price: ${amount / 1e9} SOL`);
    console.log(`Buyer: ${buyer}`);
  }
}

function handleTransfer(payload: EnhancedWebhookPayload) {
  const { nativeTransfers, tokenTransfers, signature } = payload;

  for (const transfer of nativeTransfers) {
    console.log(`SOL Transfer: ${transfer.amount / 1e9} SOL`);
    console.log(`From: ${transfer.fromUserAccount}`);
    console.log(`To: ${transfer.toUserAccount}`);
  }

  for (const transfer of tokenTransfers) {
    console.log(`Token Transfer: ${transfer.tokenAmount}`);
    console.log(`Mint: ${transfer.mint}`);
  }
}

app.listen(3000, () => {
  console.log("Webhook server running on port 3000");
});
```

### Authentication Header

Secure your webhook endpoint:

```typescript
// When creating webhook
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/webhook",
  transactionTypes: ["SWAP"],
  accountAddresses: ["address"],
  webhookType: "enhanced",
  authHeader: "Bearer your-secret-token",
});

// In your server
app.post("/webhook", (req, res) => {
  const authHeader = req.headers.authorization;

  if (authHeader !== "Bearer your-secret-token") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Process webhook...
});
```

## Retry & Deduplication

### Retry Behavior

Helius retries webhook delivery if your server doesn't respond with 2xx:
- Up to 3 retry attempts
- Exponential backoff between retries
- Duplicate events may be delivered

### Deduplication Strategy

```typescript
const processedSignatures = new Set<string>();

app.post("/webhook", (req, res) => {
  const { signature } = req.body;

  // Check for duplicate
  if (processedSignatures.has(signature)) {
    return res.status(200).json({ duplicate: true });
  }

  // Mark as processed
  processedSignatures.add(signature);

  // Clean up old signatures periodically
  if (processedSignatures.size > 10000) {
    const iterator = processedSignatures.values();
    for (let i = 0; i < 5000; i++) {
      processedSignatures.delete(iterator.next().value);
    }
  }

  // Process webhook...
  res.status(200).json({ received: true });
});
```

### Redis-Based Deduplication

```typescript
import Redis from "ioredis";

const redis = new Redis();

app.post("/webhook", async (req, res) => {
  const { signature } = req.body;

  // Try to set with NX (only if not exists), expire after 1 hour
  const isNew = await redis.set(
    `webhook:${signature}`,
    "1",
    "EX", 3600,
    "NX"
  );

  if (!isNew) {
    return res.status(200).json({ duplicate: true });
  }

  // Process webhook...
  res.status(200).json({ received: true });
});
```

## Credit Costs

| Operation | Credits |
|-----------|---------|
| Create webhook | 100 |
| Update webhook | 100 |
| Delete webhook | 100 |
| Get webhook | 100 |
| Get all webhooks | 100 |
| Event delivery | 1 per event |

## Limits

| Plan | Webhooks | Addresses/Webhook |
|------|----------|-------------------|
| Free | 2 | 25 |
| Developer | 10 | 100 |
| Growth | 50 | 500 |
| Enterprise | Unlimited | Custom |

## Best Practices

1. **Respond quickly** - Return 200 status within 30 seconds
2. **Process async** - Queue webhook data for async processing
3. **Handle duplicates** - Implement deduplication using signature
4. **Use authentication** - Set authHeader for security
5. **Monitor delivery** - Check webhook logs in dashboard
6. **Filter appropriately** - Only subscribe to needed event types
7. **Test first** - Use dashboard test feature before production
