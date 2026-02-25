# Switchboard TypeScript SDK Reference

Complete API reference for `@switchboard-xyz/on-demand` package.

## Installation

```bash
npm install @switchboard-xyz/on-demand @switchboard-xyz/common
# or
yarn add @switchboard-xyz/on-demand @switchboard-xyz/common
# or
bun add @switchboard-xyz/on-demand @switchboard-xyz/common
```

## Core Classes

### PullFeed

Primary class for interacting with Switchboard pull feeds.

```typescript
import { PullFeed } from "@switchboard-xyz/on-demand";
```

#### Constructor

```typescript
const feedAccount = new PullFeed(program: Program, pubkey: PublicKey);
```

#### Methods

##### fetchUpdateIx

Fetches oracle signatures and builds update instruction.

```typescript
const result = await feedAccount.fetchUpdateIx({
  crossbarClient: CrossbarClient,  // Crossbar client instance
  chain: string,                    // "solana"
  network: string,                  // "mainnet" | "devnet"
  numSignatures?: number,           // Number of oracle signatures (default: 1)
  variableOverrides?: Record<string, string>, // Override feed variables
});

// Returns
interface FetchUpdateResult {
  pullIx: TransactionInstruction;  // Update instruction
  responses: OracleResponse[];      // Oracle responses
  numSuccess: number;               // Successful responses
  luts: AddressLookupTableAccount[]; // Lookup tables
}
```

##### loadData

Loads current feed data from chain.

```typescript
const feedData = await feedAccount.loadData();

interface FeedData {
  value: BN;              // Current feed value
  lastUpdatedSlot: number; // Last update slot
  // ... additional fields
}
```

---

### OracleQuote

Manages oracle quote accounts for stateless price consumption.

```typescript
import { OracleQuote } from "@switchboard-xyz/on-demand";
```

#### Static Methods

##### getCanonicalPubkey

Derives the canonical oracle quote account address.

```typescript
const quotePubkey = OracleQuote.getCanonicalPubkey(
  queueKey: PublicKey,      // Queue public key
  feedHashes: string[],     // Array of feed hashes (64-char hex)
  programId?: PublicKey     // Optional: quote program ID
);
```

**Feed Hash Formats:**
- 64-character hex string: `"0xabcd..."`
- Without prefix: `"abcd..."`
- 32-byte Buffer

---

### CrossbarClient

Client for communicating with Switchboard oracles.

```typescript
import { CrossbarClient } from "@switchboard-xyz/on-demand";

const crossbar = new CrossbarClient(
  endpoint: string  // "https://crossbar.switchboard.xyz"
);
```

#### Methods

##### fetchQuoteIx

Fetches quote instruction for Oracle Quote approach.

```typescript
const sigVerifyIx = await queue.fetchQuoteIx(
  crossbar: CrossbarClient,
  feedHashes: string[],
  options?: {
    numSignatures?: number,
    variableOverrides?: Record<string, string>,
  }
);
```

---

### SwitchboardSurge

Real-time WebSocket price streaming.

```typescript
import { SwitchboardSurge } from "@switchboard-xyz/on-demand";
```

#### Constructor

```typescript
const surge = new SwitchboardSurge({
  apiKey?: string,           // Optional API key for higher rate limits
  gatewayUrl?: string,       // WebSocket URL (default: wss://surge.switchboard.xyz)
  autoReconnect?: boolean,   // Auto-reconnect on disconnect (default: true)
  maxReconnectAttempts?: number, // Max reconnection attempts (default: 5)
  reconnectDelay?: number,   // Delay between reconnects in ms (default: 1000)
});
```

#### Methods

##### subscribe

Subscribe to price feeds.

```typescript
surge.subscribe(feeds: string[]); // ["SOL/USD", "BTC/USD", ...]
```

##### Events

```typescript
surge.on("connected", () => void);
surge.on("data", (data: PriceData) => void);
surge.on("error", (error: Error) => void);
surge.on("disconnected", () => void);

interface PriceData {
  symbol: string;
  price: number;
  timestamp: number;
  confidence: number;
}
```

---

### AnchorUtils

Utility functions for Anchor integration.

```typescript
import { AnchorUtils } from "@switchboard-xyz/on-demand";
```

#### Methods

##### loadProgramFromConnection

Browser-compatible program loading.

```typescript
const program = await AnchorUtils.loadProgramFromConnection(
  connection: Connection,
  programId: PublicKey,
  wallet: Wallet
);
```

##### initKeypairFromFile (Node.js only)

```typescript
const keypair = AnchorUtils.initKeypairFromFile(path: string);
```

##### initWalletFromFile (Node.js only)

```typescript
const wallet = AnchorUtils.initWalletFromFile(path: string);
```

---

## Transaction Helpers

### asV0Tx

Builds a versioned transaction with compute budget.

```typescript
import { asV0Tx } from "@switchboard-xyz/on-demand";

const tx = await asV0Tx({
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  computeUnitPrice?: number,      // Priority fee in microlamports
  computeUnitLimitMultiple?: number, // Multiply estimated CU limit
  lookupTables?: AddressLookupTableAccount[],
});
```

---

## Types

### FeedHash

```typescript
type FeedHash = string | Buffer;

// Valid formats:
const hex = "0xabcdef1234567890..."; // 64 chars with prefix
const raw = "abcdef1234567890...";   // 64 chars without prefix
const buffer = Buffer.from([...]); // 32 bytes
```

### Network

```typescript
type Network = "mainnet" | "devnet";
```

### Chain

```typescript
type Chain = "solana" | "sui" | "evm";
```

---

## Complete Example

```typescript
import { web3, AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  PullFeed,
  CrossbarClient,
  asV0Tx,
  ON_DEMAND_MAINNET_PID,
} from "@switchboard-xyz/on-demand";

async function main() {
  // Setup
  const connection = new web3.Connection("https://api.mainnet-beta.solana.com");
  const wallet = loadWallet(); // Your wallet loading logic
  const provider = new AnchorProvider(connection, wallet, {});

  // Load program
  const sbProgram = await Program.at(ON_DEMAND_MAINNET_PID, provider);

  // Initialize crossbar
  const crossbar = new CrossbarClient("https://crossbar.switchboard.xyz");

  // Create feed reference
  const feedPubkey = new web3.PublicKey("YOUR_FEED_PUBKEY");
  const feedAccount = new PullFeed(sbProgram, feedPubkey);

  // Fetch update instruction
  const { pullIx, numSuccess, luts } = await feedAccount.fetchUpdateIx({
    crossbarClient: crossbar,
    chain: "solana",
    network: "mainnet",
    numSignatures: 3,
  });

  if (numSuccess < 1) {
    throw new Error("No oracle responses received");
  }

  // Build transaction
  const tx = await asV0Tx({
    connection,
    ixs: [pullIx],
    signers: [wallet.payer],
    computeUnitPrice: 200_000,
    computeUnitLimitMultiple: 1.3,
    lookupTables: luts,
  });

  // Send transaction
  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(signature);

  console.log("Feed updated:", signature);

  // Read feed value
  const feedData = await feedAccount.loadData();
  console.log("Current value:", feedData.value.toString());
}

main().catch(console.error);
```

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No oracle responses` | Oracles unavailable | Retry, check feed hash |
| `Insufficient signatures` | Too few oracles responded | Reduce `numSignatures` |
| `Stale feed` | Feed hasn't been updated | Call `fetchUpdateIx` first |
| `Invalid feed hash` | Malformed feed hash | Use correct format |

### Error Handling Pattern

```typescript
try {
  const { pullIx, numSuccess } = await feedAccount.fetchUpdateIx({...});

  if (numSuccess < minRequired) {
    throw new Error(`Only ${numSuccess} oracles responded`);
  }

  // Continue with transaction...
} catch (error) {
  if (error.message.includes("timeout")) {
    console.log("Oracle timeout, retrying...");
    // Implement retry logic
  } else if (error.message.includes("rate limit")) {
    console.log("Rate limited, waiting...");
    await sleep(5000);
  } else {
    throw error;
  }
}
```
