# Helius RPC Methods Reference

Complete reference for Helius RPC methods - standard Solana RPC plus Helius-exclusive enhancements.

## Endpoints

| Network | HTTP | WebSocket |
|---------|------|-----------|
| Mainnet | `https://mainnet.helius-rpc.com/?api-key=<KEY>` | `wss://mainnet.helius-rpc.com/?api-key=<KEY>` |
| Devnet | `https://devnet.helius-rpc.com/?api-key=<KEY>` | `wss://devnet.helius-rpc.com/?api-key=<KEY>` |

## Standard RPC Methods

### Account Methods

#### getAccountInfo

```typescript
const accountInfo = await rpc.getAccountInfo(address, {
  encoding: "base64",
  commitment: "confirmed",
}).send();
```

#### getBalance

```typescript
const balance = await rpc.getBalance(address, {
  commitment: "confirmed",
}).send();
// Returns { context, value } where value is lamports
```

#### getMultipleAccounts

```typescript
const accounts = await rpc.getMultipleAccounts(
  [address1, address2, address3],
  { encoding: "base64" }
).send();
```

#### getProgramAccounts

```typescript
const accounts = await rpc.getProgramAccounts(programId, {
  encoding: "base64",
  filters: [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: "base58_encoded_bytes" } },
  ],
}).send();
```

### Block Methods

#### getBlock

```typescript
const block = await rpc.getBlock(slot, {
  encoding: "json",
  transactionDetails: "full",
  rewards: true,
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
}).send();
```

#### getBlockHeight

```typescript
const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
```

#### getBlocks

```typescript
const blocks = await rpc.getBlocks(startSlot, endSlot, {
  commitment: "confirmed",
}).send();
```

#### getBlockTime

```typescript
const timestamp = await rpc.getBlockTime(slot).send();
// Returns Unix timestamp
```

### Transaction Methods

#### getTransaction

```typescript
const tx = await rpc.getTransaction(signature, {
  encoding: "json",
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
}).send();
```

#### getSignaturesForAddress

```typescript
const signatures = await rpc.getSignaturesForAddress(address, {
  limit: 100,
  before: lastSignature,
  commitment: "confirmed",
}).send();
```

#### getSignatureStatuses

```typescript
const statuses = await rpc.getSignatureStatuses(
  [signature1, signature2],
  { searchTransactionHistory: true }
).send();
```

#### sendTransaction

```typescript
const signature = await rpc.sendTransaction(
  base64EncodedTransaction,
  {
    encoding: "base64",
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  }
).send();
```

#### simulateTransaction

```typescript
const result = await rpc.simulateTransaction(
  base64EncodedTransaction,
  {
    encoding: "base64",
    commitment: "confirmed",
    replaceRecentBlockhash: true,
    accounts: {
      addresses: [address1, address2],
      encoding: "base64",
    },
  }
).send();
```

### Token Methods

#### getTokenAccountBalance

```typescript
const balance = await rpc.getTokenAccountBalance(
  tokenAccountAddress,
  { commitment: "confirmed" }
).send();
```

#### getTokenAccountsByOwner

```typescript
const accounts = await rpc.getTokenAccountsByOwner(
  ownerAddress,
  { mint: mintAddress }, // or { programId: tokenProgramId }
  { encoding: "jsonParsed" }
).send();
```

#### getTokenAccountsByDelegate

```typescript
const accounts = await rpc.getTokenAccountsByDelegate(
  delegateAddress,
  { mint: mintAddress },
  { encoding: "jsonParsed" }
).send();
```

#### getTokenLargestAccounts

```typescript
const accounts = await rpc.getTokenLargestAccounts(
  mintAddress,
  { commitment: "confirmed" }
).send();
```

#### getTokenSupply

```typescript
const supply = await rpc.getTokenSupply(
  mintAddress,
  { commitment: "confirmed" }
).send();
```

### Cluster Methods

#### getClusterNodes

```typescript
const nodes = await rpc.getClusterNodes().send();
```

#### getEpochInfo

```typescript
const epochInfo = await rpc.getEpochInfo({ commitment: "confirmed" }).send();
// Returns { epoch, slotIndex, slotsInEpoch, absoluteSlot, blockHeight, transactionCount }
```

#### getEpochSchedule

```typescript
const schedule = await rpc.getEpochSchedule().send();
```

#### getHealth

```typescript
const health = await rpc.getHealth().send();
// Returns "ok" if healthy
```

#### getSlot

```typescript
const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
```

#### getSlotLeader

```typescript
const leader = await rpc.getSlotLeader({ commitment: "confirmed" }).send();
```

#### getVersion

```typescript
const version = await rpc.getVersion().send();
```

#### getVoteAccounts

```typescript
const voteAccounts = await rpc.getVoteAccounts({
  commitment: "confirmed",
  votePubkey: validatorPubkey, // optional filter
}).send();
```

### Utility Methods

#### getLatestBlockhash

```typescript
const { value: blockhash } = await rpc.getLatestBlockhash({
  commitment: "confirmed",
}).send();
// Returns { blockhash, lastValidBlockHeight }
```

#### isBlockhashValid

```typescript
const valid = await rpc.isBlockhashValid(blockhash, {
  commitment: "confirmed",
}).send();
```

#### getFeeForMessage

```typescript
const fee = await rpc.getFeeForMessage(
  base64EncodedMessage,
  { commitment: "confirmed" }
).send();
```

#### getMinimumBalanceForRentExemption

```typescript
const lamports = await rpc.getMinimumBalanceForRentExemption(
  dataSize,
  { commitment: "confirmed" }
).send();
```

#### getRecentPrioritizationFees

```typescript
const fees = await rpc.getRecentPrioritizationFees(
  [address1, address2] // optional account addresses
).send();
```

#### requestAirdrop

```typescript
// Devnet only
const signature = await rpc.requestAirdrop(
  address,
  lamports,
  { commitment: "confirmed" }
).send();
```

### Supply & Inflation

#### getSupply

```typescript
const supply = await rpc.getSupply({
  commitment: "confirmed",
  excludeNonCirculatingAccountsList: true,
}).send();
```

#### getInflationGovernor

```typescript
const governor = await rpc.getInflationGovernor({ commitment: "confirmed" }).send();
```

#### getInflationRate

```typescript
const rate = await rpc.getInflationRate().send();
```

#### getInflationReward

```typescript
const rewards = await rpc.getInflationReward(
  [address1, address2],
  { epoch: epochNumber, commitment: "confirmed" }
).send();
```

#### getLargestAccounts

```typescript
const accounts = await rpc.getLargestAccounts({
  commitment: "confirmed",
  filter: "circulating", // or "nonCirculating"
}).send();
```

## Helius-Exclusive Methods

### getProgramAccountsV2

Cursor-based pagination for large program account sets.

```typescript
// First request
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccountsV2",
    params: [
      programId,
      {
        encoding: "base64",
        filters: [{ dataSize: 165 }],
        cursor: null, // Start from beginning
        limit: 100,
      },
    ],
  }),
});

const { result } = await response.json();
// result.accounts - array of accounts
// result.cursor - use for next page, null if no more

// Pagination
let cursor = null;
const allAccounts = [];

do {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccountsV2",
      params: [programId, { encoding: "base64", cursor, limit: 1000 }],
    }),
  });

  const { result } = await response.json();
  allAccounts.push(...result.accounts);
  cursor = result.cursor;
} while (cursor);
```

### getTokenAccountsByOwnerV2

Efficient token account retrieval with cursor pagination.

```typescript
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwnerV2",
    params: [
      ownerAddress,
      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      {
        encoding: "jsonParsed",
        cursor: null,
        limit: 100,
      },
    ],
  }),
});
```

### getTransactionsForAddress

Advanced transaction history with filtering and sorting.

```typescript
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransactionsForAddress",
    params: [
      address,
      {
        before: null,          // Signature to start before
        until: null,           // Signature to stop at
        limit: 100,            // Max results
        source: "JUPITER",     // Filter by source
        type: "SWAP",          // Filter by type
        commitment: "confirmed",
      },
    ],
  }),
});

const { result } = await response.json();
// Returns array of parsed transactions
```

**Source Filters:**
- `JUPITER` - Jupiter aggregator
- `RAYDIUM` - Raydium AMM
- `ORCA` - Orca DEX
- `MAGIC_EDEN` - Magic Eden marketplace
- `TENSOR` - Tensor marketplace
- And many more...

**Type Filters:**
- `SWAP`
- `TRANSFER`
- `NFT_SALE`
- `NFT_LISTING`
- `NFT_BID`
- `TOKEN_MINT`
- `STAKE`
- `UNSTAKE`

## WebSocket Subscriptions

### accountSubscribe

```typescript
const ws = new WebSocket(WS_URL);

ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "accountSubscribe",
  params: [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ],
}));

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.method === "accountNotification") {
    console.log("Account changed:", data.params.result);
  }
};
```

### programSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "programSubscribe",
  params: [
    programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [{ dataSize: 165 }],
    },
  ],
}));
```

### logsSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "logsSubscribe",
  params: [
    { mentions: [programId] }, // or "all" or "allWithVotes"
    { commitment: "confirmed" },
  ],
}));
```

### signatureSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "signatureSubscribe",
  params: [
    signature,
    { commitment: "confirmed" },
  ],
}));
```

### slotSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "slotSubscribe",
  params: [],
}));
```

### blockSubscribe

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "blockSubscribe",
  params: [
    "all", // or { mentionsAccountOrProgram: programId }
    {
      commitment: "confirmed",
      encoding: "json",
      transactionDetails: "full",
      showRewards: true,
      maxSupportedTransactionVersion: 0,
    },
  ],
}));
```

### Unsubscribing

```typescript
ws.send(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "accountUnsubscribe",
  params: [subscriptionId],
}));
```

## Commitment Levels

| Level | Description |
|-------|-------------|
| `processed` | Fastest, node processed but not confirmed |
| `confirmed` | Voted on by supermajority (recommended) |
| `finalized` | Confirmed by supermajority, irreversible |

## Best Practices

### Batching Requests

```typescript
// Batch multiple calls in one request
const response = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] },
    { jsonrpc: "2.0", id: 2, method: "getBlockHeight", params: [] },
    { jsonrpc: "2.0", id: 3, method: "getHealth", params: [] },
  ]),
});

const results = await response.json();
// Array of responses
```

### Connection Pooling

```typescript
// Create RPC once, reuse everywhere
const rpc = createSolanaRpc(RPC_URL);

// Reuse for all calls
await rpc.getBalance(addr1).send();
await rpc.getBalance(addr2).send();
```

### Error Handling

```typescript
try {
  const result = await rpc.getAccountInfo(address).send();
} catch (error) {
  if (error.code === -32600) {
    console.error("Invalid request");
  } else if (error.code === -32601) {
    console.error("Method not found");
  } else if (error.code === -32602) {
    console.error("Invalid params");
  } else if (error.code === -32603) {
    console.error("Internal error");
  }
}
```

## Rate Limits

Standard Helius rate limits:
- Free: 10 requests/second
- Developer: 50 requests/second
- Growth: 200 requests/second
- Enterprise: Custom

Use exponential backoff for 429 errors:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 && i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries exceeded");
}
```
