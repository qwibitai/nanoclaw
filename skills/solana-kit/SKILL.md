---
name: solana-kit
description: Complete guide for @solana/kit - the modern, tree-shakeable, zero-dependency JavaScript SDK from Anza. Covers RPC connections, signers, transaction building with pipe, signing, sending, and account fetching with full TypeScript support.
---

# Solana Kit Development Guide

A comprehensive guide for building Solana applications with `@solana/kit` - the modern, tree-shakeable, zero-dependency JavaScript SDK from Anza.

## Overview

Solana Kit (formerly web3.js 2.0) is a complete rewrite of the Solana JavaScript SDK with:
- **Tree-shakeable**: Only ship code you use (-78% bundle size)
- **Zero dependencies**: No third-party packages
- **Functional design**: Composable, no classes
- **10x faster crypto**: Native Ed25519 support
- **TypeScript-first**: Full type safety

## Quick Start

### Installation

```bash
npm install @solana/kit
```

For specific program interactions:
```bash
npm install @solana-program/system @solana-program/token
```

### Minimal Example

```typescript
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

async function transferSol() {
  // 1. Connect to RPC
  const rpc = createSolanaRpc("https://api.devnet.solana.com");
  const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

  // 2. Create signers
  const sender = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();

  // 3. Get blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // 4. Build transaction with pipe
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(sender.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstruction(
      getTransferSolInstruction({
        amount: lamports(LAMPORTS_PER_SOL / BigInt(10)), // 0.1 SOL
        destination: recipient.address,
        source: sender,
      }),
      tx
    )
  );

  // 5. Sign
  const signedTx = await signTransactionMessageWithSigners(transactionMessage);

  // 6. Send and confirm
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: "confirmed" });

  console.log("Signature:", getSignatureFromTransaction(signedTx));
}
```

## Core Concepts

### 1. RPC Connections

Kit separates HTTP and WebSocket connections:

```typescript
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

// HTTP for requests
const rpc = createSolanaRpc("https://api.devnet.solana.com");

// WebSocket for subscriptions
const rpcSubscriptions = createSolanaRpcSubscriptions("wss://api.devnet.solana.com");

// Make RPC calls
const slot = await rpc.getSlot().send();
const balance = await rpc.getBalance(address).send();
const { value: blockhash } = await rpc.getLatestBlockhash().send();
```

### 2. Signers

Kit uses signer interfaces instead of keypairs directly:

```typescript
import {
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  address,
} from "@solana/kit";

// Generate new signer
const signer = await generateKeyPairSigner();
console.log("Address:", signer.address);

// From existing secret key (Uint8Array)
const existing = await createKeyPairSignerFromBytes(secretKeyBytes);

// Create address from string
const addr = address("11111111111111111111111111111111");
```

### 3. Transaction Building with Pipe

Kit uses functional composition via `pipe`:

```typescript
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  prependTransactionMessageInstructions,
} from "@solana/kit";

const tx = pipe(
  createTransactionMessage({ version: 0 }),             // Create v0 message
  (tx) => setTransactionMessageFeePayer(payer.address, tx),  // Set fee payer
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx), // Set lifetime
  (tx) => appendTransactionMessageInstruction(instruction1, tx),      // Add instruction
  (tx) => appendTransactionMessageInstructions([instruction2, instruction3], tx), // Add multiple
);
```

### 4. Signing Transactions

```typescript
import {
  signTransactionMessageWithSigners,
  partiallySignTransactionMessageWithSigners,
  getSignatureFromTransaction,
} from "@solana/kit";

// Sign with all signers in the transaction
const signedTx = await signTransactionMessageWithSigners(transactionMessage);

// Partial signing (for multisig)
const partiallySignedTx = await partiallySignTransactionMessageWithSigners(
  transactionMessage
);

// Get signature before sending
const signature = getSignatureFromTransaction(signedTx);
```

### 5. Sending Transactions

```typescript
import {
  sendAndConfirmTransactionFactory,
  sendTransactionWithoutConfirmingFactory,
  getBase64EncodedWireTransaction,
} from "@solana/kit";

// Send with confirmation (recommended)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTx, { commitment: "confirmed" });

// Send without waiting for confirmation
const send = sendTransactionWithoutConfirmingFactory({ rpc });
await send(signedTx, { commitment: "confirmed" });

// Manual encoding (low-level)
const encoded = getBase64EncodedWireTransaction(signedTx);
await rpc.sendTransaction(encoded, { encoding: "base64" }).send();
```

### 6. Fetching Accounts

```typescript
import {
  fetchEncodedAccount,
  fetchEncodedAccounts,
  assertAccountExists,
} from "@solana/kit";

// Fetch single account
const account = await fetchEncodedAccount(rpc, address);
if (account.exists) {
  console.log("Lamports:", account.lamports);
  console.log("Owner:", account.programAddress);
  console.log("Data:", account.data);
}

// Fetch multiple accounts
const accounts = await fetchEncodedAccounts(rpc, [addr1, addr2, addr3]);

// Assert account exists (throws if not)
assertAccountExists(account);
```

## Package Reference

### Core Package

| Import | Description |
|--------|-------------|
| `@solana/kit` | Main package - includes everything below |

### Individual Packages

| Package | Purpose |
|---------|---------|
| `@solana/rpc` | RPC client creation |
| `@solana/rpc-subscriptions` | WebSocket subscriptions |
| `@solana/signers` | Signing interfaces |
| `@solana/addresses` | Address utilities |
| `@solana/keys` | Key generation |
| `@solana/transactions` | Transaction compilation |
| `@solana/transaction-messages` | Message building |
| `@solana/accounts` | Account fetching |
| `@solana/codecs` | Data encoding/decoding |
| `@solana/errors` | Error handling |

### Program Packages

| Package | Program |
|---------|---------|
| `@solana-program/system` | System Program |
| `@solana-program/token` | SPL Token |
| `@solana-program/token-2022` | Token Extensions |
| `@solana-program/memo` | Memo Program |
| `@solana-program/compute-budget` | Compute Budget |
| `@solana-program/address-lookup-table` | Lookup Tables |

## Common Patterns

### Pattern 1: Helper Function for Send & Confirm

```typescript
import {
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  CompilableTransactionMessage,
  TransactionMessageWithBlockhashLifetime,
  Commitment,
} from "@solana/kit";

function createTransactionSender(rpc: Rpc, rpcSubscriptions: RpcSubscriptions) {
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  return async (
    txMessage: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime,
    commitment: Commitment = "confirmed"
  ) => {
    const signedTx = await signTransactionMessageWithSigners(txMessage);
    await sendAndConfirm(signedTx, { commitment, skipPreflight: false });
    return getSignatureFromTransaction(signedTx);
  };
}

// Usage
const sendTx = createTransactionSender(rpc, rpcSubscriptions);
const signature = await sendTx(transactionMessage);
```

### Pattern 2: Reusable Transaction Builder

```typescript
import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  IInstruction,
} from "@solana/kit";

async function buildTransaction(
  rpc: Rpc,
  feePayer: Address,
  instructions: IInstruction[]
) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );
}
```

### Pattern 3: Add Compute Budget

```typescript
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

const computeInstructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  getSetComputeUnitPriceInstruction({ microLamports: 1000n }),
];

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(payer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => prependTransactionMessageInstructions(computeInstructions, tx), // Prepend!
  (tx) => appendTransactionMessageInstruction(mainInstruction, tx),
);
```

### Pattern 4: Versioned Transactions with Lookup Tables

```typescript
import {
  setTransactionMessageAddressLookupTable,
} from "@solana/kit";

// Fetch lookup table
const lookupTableAccount = await fetchAddressLookupTable(rpc, lookupTableAddress);

const tx = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayer(payer.address, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => setTransactionMessageAddressLookupTable(tx, lookupTableAccount),
  (tx) => appendTransactionMessageInstructions(instructions, tx),
);
```

## Type Safety

Kit provides comprehensive TypeScript types:

```typescript
import type {
  Address,
  Signature,
  Lamports,
  TransactionMessage,
  Rpc,
  RpcSubscriptions,
  KeyPairSigner,
} from "@solana/kit";

// Addresses are branded strings
const addr: Address = address("11111111111111111111111111111111");

// Lamports are branded bigints
const amount: Lamports = lamports(1_000_000_000n);

// Type-safe RPC responses
const response = await rpc.getBalance(addr).send();
// response.value is typed as Lamports
```

## Performance Tips

1. **Import only what you need** - Kit is tree-shakeable
   ```typescript
   // Good - only imports what's used
   import { createSolanaRpc, generateKeyPairSigner } from "@solana/kit";

   // Also good - use subpackages for smaller bundles
   import { createSolanaRpc } from "@solana/rpc";
   import { generateKeyPairSigner } from "@solana/signers";
   ```

2. **Reuse RPC connections** - Don't create per request
   ```typescript
   // Create once
   const rpc = createSolanaRpc(endpoint);

   // Reuse everywhere
   await rpc.getBalance(addr1).send();
   await rpc.getBalance(addr2).send();
   ```

3. **Batch requests when possible**
   ```typescript
   // Fetch multiple accounts in one request
   const accounts = await fetchEncodedAccounts(rpc, [addr1, addr2, addr3]);
   ```

4. **Use skipPreflight carefully** - Faster but no simulation
   ```typescript
   await sendAndConfirm(tx, { commitment: "confirmed", skipPreflight: true });
   ```

## Error Handling

```typescript
import { isSolanaError, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS } from "@solana/errors";

try {
  await sendAndConfirm(signedTx, { commitment: "confirmed" });
} catch (error) {
  if (isSolanaError(error, SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS)) {
    console.error("Not enough SOL for transaction");
  } else if (isSolanaError(error)) {
    console.error("Solana error:", error.context);
  } else {
    throw error;
  }
}
```

## Migration from web3.js 1.x

See the separate migration skill or use `@solana/compat` for interoperability:

```typescript
import {
  fromLegacyPublicKey,
  fromLegacyKeypair,
  fromVersionedTransaction,
  fromLegacyTransactionInstruction,
} from "@solana/compat";

// Convert legacy PublicKey to Kit Address
const address = fromLegacyPublicKey(legacyPublicKey);

// Convert legacy Keypair to Kit CryptoKeyPair (async)
const keyPair = await fromLegacyKeypair(legacyKeypair);

// Convert legacy VersionedTransaction to Kit Transaction
const kitTransaction = fromVersionedTransaction(legacyVersionedTx);

// Convert legacy TransactionInstruction to Kit Instruction
const kitInstruction = fromLegacyTransactionInstruction(legacyInstruction);
```

> **Note**: The compat package converts FROM legacy TO Kit types. For reverse conversion, you may need to manually construct legacy objects.

## Performance Benchmarks

Kit delivers significant performance improvements over web3.js 1.x:

| Metric | web3.js 1.x | @solana/kit | Improvement |
|--------|-------------|-------------|-------------|
| Keypair Generation | ~50ms | ~5ms | **10x faster** |
| Transaction Signing | ~20ms | ~2ms | **10x faster** |
| Bundle Size | 311KB | 226KB | **26% smaller** |
| Confirmation Latency | ~400ms | ~200ms | **~200ms faster** |

*Benchmarks from Triton One's Ping Thing service and Solana Explorer testing*

### Why It's Faster

1. **Native Ed25519**: Uses browser/runtime native crypto APIs
2. **Zero Dependencies**: No third-party library overhead
3. **Tree-Shakeable**: Only imports code you use
4. **No Classes**: Functional design enables better optimization

## Resources

- [Official Documentation](https://www.solanakit.com/docs)
- [GitHub Repository](https://github.com/anza-xyz/kit)
- [Examples](https://github.com/anza-xyz/kit/tree/main/examples)
- [Triton Blog - Kit Introduction](https://blog.triton.one/intro-to-the-new-solana-kit-formerly-web3-js-2/)

## Skill Structure

```
solana-kit/
├── SKILL.md                    # This file
├── resources/
│   ├── packages-reference.md   # Complete package documentation
│   └── api-quick-reference.md  # Quick lookup table
├── examples/
│   ├── transfer-sol/           # Basic SOL transfer
│   ├── create-token/           # SPL token creation
│   ├── fetch-accounts/         # Account fetching & decoding
│   └── subscriptions/          # Real-time subscriptions
├── templates/
│   └── project-template.ts     # Copy-paste starter
└── docs/
    ├── advanced-patterns.md    # Complex patterns
    └── troubleshooting.md      # Common issues
```
