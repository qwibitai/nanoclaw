# Helius SDK Reference

Complete reference for the Helius Node.js/TypeScript SDK.

## Installation

```bash
# npm
npm install helius-sdk

# pnpm (recommended)
pnpm add helius-sdk

# yarn
yarn add helius-sdk
```

## Initialization

```typescript
import { createHelius } from "helius-sdk";

// Basic initialization
const helius = createHelius({
  apiKey: process.env.HELIUS_API_KEY!,
});

// With options
const helius = createHelius({
  apiKey: process.env.HELIUS_API_KEY!,
  cluster: "mainnet-beta", // or "devnet"
});
```

## SDK Namespaces

The SDK organizes methods into logical namespaces:

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

---

## Root Methods (helius.*)

### DAS API Methods

```typescript
// Get single asset
const asset = await helius.getAsset({
  id: "asset_mint_address",
  displayOptions: {
    showFungible: true,
    showNativeBalance: true,
  },
});

// Get batch of assets
const assets = await helius.getAssetBatch({
  ids: ["asset1", "asset2", "asset3"],
});

// Get assets by owner
const ownerAssets = await helius.getAssetsByOwner({
  ownerAddress: "wallet_address",
  page: 1,
  limit: 100,
});

// Get assets by creator
const creatorAssets = await helius.getAssetsByCreator({
  creatorAddress: "creator_address",
  onlyVerified: true,
  page: 1,
});

// Get assets by authority
const authorityAssets = await helius.getAssetsByAuthority({
  authorityAddress: "authority_address",
  page: 1,
});

// Get assets by group (collection)
const collectionAssets = await helius.getAssetsByGroup({
  groupKey: "collection",
  groupValue: "collection_address",
  page: 1,
});

// Search assets
const searchResults = await helius.searchAssets({
  ownerAddress: "wallet_address",
  tokenType: "fungible",
  burnt: false,
});

// Get asset proof
const proof = await helius.getAssetProof({
  id: "compressed_nft_id",
});

// Get batch proofs
const proofs = await helius.getAssetProofBatch({
  ids: ["cnft1", "cnft2"],
});

// Get NFT editions
const editions = await helius.getNftEditions({
  mint: "master_edition_mint",
  page: 1,
});

// Get token accounts
const tokenAccounts = await helius.getTokenAccounts({
  owner: "wallet_address",
  page: 1,
});

// Get signatures for asset
const signatures = await helius.getSignaturesForAsset({
  id: "asset_id",
  page: 1,
});
```

### Priority Fee API

```typescript
// Get priority fee estimate
const estimate = await helius.getPriorityFeeEstimate({
  accountKeys: ["account1", "account2"],
  options: {
    priorityLevel: "HIGH",
    includeAllPriorityFeeLevels: true,
  },
});

// Or with transaction
const estimate = await helius.getPriorityFeeEstimate({
  transaction: base64EncodedTransaction,
  options: {
    priorityLevel: "MEDIUM",
  },
});
```

---

## RPC Methods (helius.rpc.*)

Enhanced RPC methods exclusive to Helius.

```typescript
// getProgramAccountsV2 - cursor pagination
const programAccounts = await helius.rpc.getProgramAccountsV2({
  programAddress: "program_id",
  cursor: null,
  limit: 100,
  filters: [{ dataSize: 165 }],
});

// getTokenAccountsByOwnerV2 - cursor pagination
const tokenAccounts = await helius.rpc.getTokenAccountsByOwnerV2({
  ownerAddress: "wallet_address",
  cursor: null,
  limit: 100,
});

// getTransactionsForAddress - advanced filtering
const transactions = await helius.rpc.getTransactionsForAddress({
  address: "wallet_address",
  before: null,
  until: null,
  limit: 100,
  source: "JUPITER",
  type: "SWAP",
});
```

---

## Transaction Methods (helius.tx.*)

Optimized transaction sending and management.

```typescript
// Send smart transaction (with retry and optimization)
const signature = await helius.tx.sendSmartTransaction({
  transaction: base64EncodedTransaction,
  skipPreflight: false,
  maxRetries: 3,
});

// Get compute units estimate
const computeUnits = await helius.tx.getComputeUnits({
  transaction: base64EncodedTransaction,
});

// Broadcast transaction
const result = await helius.tx.broadcastTransaction({
  transaction: base64EncodedTransaction,
  skipPreflight: false,
});
```

---

## Staking Methods (helius.staking.*)

Stake SOL with Helius validator.

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

// Get Helius stake accounts for owner
const stakeAccounts = await helius.staking.getHeliusStakeAccounts({
  ownerAddress: "wallet_address",
});
```

---

## Enhanced Methods (helius.enhanced.*)

Parsed transaction data.

```typescript
// Get parsed transactions by signature
const parsed = await helius.enhanced.getTransactions({
  transactions: ["sig1", "sig2", "sig3"],
});

// Get parsed transaction history
const history = await helius.enhanced.getTransactionsByAddress({
  address: "wallet_address",
  type: "SWAP",
  source: "JUPITER",
});
```

---

## Webhook Methods (helius.webhooks.*)

Webhook management.

```typescript
// Create webhook
const webhook = await helius.webhooks.createWebhook({
  webhookURL: "https://your-server.com/webhook",
  transactionTypes: ["SWAP", "NFT_SALE"],
  accountAddresses: ["address1", "address2"],
  webhookType: "enhanced",
  authHeader: "Bearer token",
});

// Get all webhooks
const webhooks = await helius.webhooks.getAllWebhooks();

// Get webhook by ID
const webhook = await helius.webhooks.getWebhookByID({
  webhookID: "webhook_id",
});

// Update webhook
await helius.webhooks.updateWebhook({
  webhookID: "webhook_id",
  webhookURL: "https://new-url.com/webhook",
  transactionTypes: ["SWAP"],
  accountAddresses: ["new_address"],
});

// Delete webhook
await helius.webhooks.deleteWebhook({
  webhookID: "webhook_id",
});
```

---

## WebSocket Methods (helius.ws.*)

Real-time subscriptions.

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

// Subscribe to signature status
const sigSub = await helius.ws.signatureNotifications({
  signature: "transaction_signature",
  commitment: "confirmed",
  callback: (status) => {
    console.log("Status:", status);
  },
});

// Subscribe to slot changes
const slotSub = await helius.ws.slotNotifications({
  callback: (slot) => {
    console.log("New slot:", slot);
  },
});

// Unsubscribe
await accountSub.unsubscribe();
await logsSub.unsubscribe();
```

---

## ZK Compression Methods (helius.zk.*)

Compressed accounts and tokens.

```typescript
// Get compressed account
const account = await helius.zk.getCompressedAccount({
  address: "compressed_address",
});

// Get multiple compressed accounts
const accounts = await helius.zk.getMultipleCompressedAccounts({
  addresses: ["addr1", "addr2"],
});

// Get compressed accounts by owner
const ownerAccounts = await helius.zk.getCompressedAccountsByOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});

// Get compressed balance
const balance = await helius.zk.getCompressedBalance({
  address: "compressed_address",
});

// Get compressed account proof
const proof = await helius.zk.getCompressedAccountProof({
  address: "compressed_address",
});

// Get compressed token accounts
const tokenAccounts = await helius.zk.getCompressedTokenAccountsByOwner({
  owner: "wallet_address",
  mint: "token_mint", // optional
});

// Get compressed token balances
const balances = await helius.zk.getCompressedTokenBalancesByOwner({
  owner: "wallet_address",
});

// Get validity proof
const validityProof = await helius.zk.getValidityProof({
  hashes: ["hash1", "hash2"],
});

// Get compression signatures
const signatures = await helius.zk.getCompressionSignaturesForOwner({
  owner: "wallet_address",
  cursor: null,
  limit: 100,
});

// Check indexer health
const health = await helius.zk.getIndexerHealth();

// Get indexer slot
const slot = await helius.zk.getIndexerSlot();
```

---

## Error Handling

```typescript
try {
  const assets = await helius.getAssetsByOwner({
    ownerAddress: "invalid_address",
  });
} catch (error) {
  if (error.response) {
    // API error
    const status = error.response.status;
    const data = error.response.data;

    switch (status) {
      case 400:
        console.error("Bad request:", data);
        break;
      case 401:
        console.error("Invalid API key");
        break;
      case 429:
        console.error("Rate limited");
        break;
      case 500:
        console.error("Server error");
        break;
    }
  } else if (error.request) {
    // Network error
    console.error("Network error:", error.message);
  } else {
    // Other error
    console.error("Error:", error.message);
  }
}
```

---

## TypeScript Types

The SDK exports comprehensive TypeScript types:

```typescript
import type {
  // Assets
  Asset,
  AssetProof,
  AssetsByOwnerResponse,
  SearchAssetsResponse,

  // Transactions
  EnhancedTransaction,
  TransactionType,
  TransactionSource,

  // Webhooks
  Webhook,
  WebhookType,

  // Priority Fees
  PriorityFeeEstimate,
  PriorityLevel,

  // ZK Compression
  CompressedAccount,
  CompressedAccountProof,
  CompressedTokenAccount,
  ValidityProof,

  // Options
  DisplayOptions,
  GetAssetOptions,
  SearchAssetsOptions,
} from "helius-sdk";
```

---

## Configuration Options

```typescript
interface HeliusConfig {
  apiKey: string;
  cluster?: "mainnet-beta" | "devnet";
  timeout?: number; // Request timeout in ms
  retries?: number; // Number of retries
}

const helius = createHelius({
  apiKey: "your-api-key",
  cluster: "mainnet-beta",
  timeout: 30000,
  retries: 3,
});
```

---

## Version 2.0.0 Changes

SDK v2.0.0 uses `@solana/kit` instead of `@solana/web3.js`:

```typescript
// SDK now internally uses @solana/kit
// API remains compatible, but improved performance

// If you need @solana/web3.js compatibility:
import { fromLegacyKeypair, toLegacyPublicKey } from "@solana/compat";
```

---

## Best Practices

1. **Initialize once** - Create Helius instance once, reuse everywhere
2. **Use environment variables** - Never hardcode API keys
3. **Handle errors** - Implement proper error handling for all API calls
4. **Batch when possible** - Use batch methods to reduce API calls
5. **Cache appropriately** - Cache DAS responses that don't change frequently
6. **Monitor rate limits** - Track credit usage via dashboard
