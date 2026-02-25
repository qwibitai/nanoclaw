# Light Protocol Troubleshooting Guide

Common issues and solutions when working with Light Protocol and ZK Compression.

## Table of Contents

- [RPC Connection Issues](#rpc-connection-issues)
- [Token Pool Errors](#token-pool-errors)
- [Balance and Account Issues](#balance-and-account-issues)
- [Transaction Errors](#transaction-errors)
- [Indexer Issues](#indexer-issues)
- [SDK Issues](#sdk-issues)

---

## RPC Connection Issues

### Error: "Method not found" or "RPC method not supported"

**Cause:** Your RPC endpoint doesn't support ZK Compression methods.

**Solution:** Use a ZK Compression-enabled RPC provider like Helius.

```typescript
// Wrong - standard RPC doesn't support compression
const rpc = new Connection("https://api.mainnet-beta.solana.com");

// Correct - use Helius or another compression-enabled RPC
import { createRpc } from "@lightprotocol/stateless.js";

const rpc = createRpc(
  "https://mainnet.helius-rpc.com?api-key=YOUR_API_KEY",
  "https://mainnet.helius-rpc.com?api-key=YOUR_API_KEY"
);
```

### Error: "401 Unauthorized" or "Invalid API key"

**Cause:** Missing or invalid Helius API key.

**Solution:**
1. Get a free API key from [helius.dev](https://helius.dev)
2. Include the key in your RPC URL

```bash
# .env
RPC_ENDPOINT=https://mainnet.helius-rpc.com?api-key=YOUR_ACTUAL_KEY
```

### Error: "Rate limit exceeded"

**Cause:** Too many requests to the RPC endpoint.

**Solution:** Add delays between requests or upgrade your Helius plan.

```typescript
async function withDelay<T>(fn: () => Promise<T>, delayMs = 500): Promise<T> {
  const result = await fn();
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return result;
}
```

---

## Token Pool Errors

### Error: "TokenPool not found"

**Cause:** The SPL mint doesn't have a token pool for compression.

**Solution:** Create a token pool before compressing.

```typescript
import { createTokenPool, createMint } from "@lightprotocol/compressed-token";

// Option 1: Create new mint with built-in token pool
const { mint } = await createMint(rpc, payer, authority, decimals);

// Option 2: Add token pool to existing SPL mint
await createTokenPool(rpc, payer, existingMint);
```

### Error: "Token pool already exists"

**Cause:** Trying to create a token pool for a mint that already has one.

**Solution:** Catch and ignore this error, or check first.

```typescript
try {
  await createTokenPool(rpc, payer, mint);
} catch (error) {
  if (!error.message?.includes("already exists")) {
    throw error;
  }
  // Pool already exists, continue
}
```

---

## Balance and Account Issues

### Error: "Insufficient balance"

**Cause:** Not enough tokens to complete the operation.

**Solution:** Check balance before transferring.

```typescript
async function safeTransfer(rpc, payer, mint, amount, sender, recipient) {
  const accounts = await rpc.getCompressedTokenAccountsByOwner(sender.publicKey, { mint });
  const balance = accounts.items.reduce(
    (sum, acc) => sum + BigInt(acc.parsed.amount),
    BigInt(0)
  );

  if (balance < BigInt(amount)) {
    throw new Error(`Insufficient balance: have ${balance}, need ${amount}`);
  }

  return await transfer(rpc, payer, mint, amount, sender, recipient);
}
```

### Error: "Amount and toPubkey arrays must have the same length"

**Cause:** Mismatched arrays when minting to multiple recipients.

**Solution:** Ensure arrays have the same length.

```typescript
// Wrong
await mintTo(rpc, payer, mint, [addr1, addr2], authority, [amount1]);

// Correct
await mintTo(rpc, payer, mint, [addr1, addr2], authority, [amount1, amount2]);
```

### Error: "No compressed accounts found"

**Cause:** The owner has no compressed token accounts.

**Solution:** Mint some tokens first, or check the correct owner.

```typescript
const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });

if (accounts.items.length === 0) {
  console.log("No accounts found. Mint tokens first:");
  await mintTo(rpc, payer, mint, owner, authority, amount);
}
```

---

## Transaction Errors

### Error: "Transaction too large" or "Account limit exceeded"

**Cause:** Compressed token transactions have a limit of ~4 accounts per transaction.

**Solution:** Split into multiple transactions.

```typescript
const MAX_ACCOUNTS = 4;

async function batchMint(recipients, amounts) {
  const signatures = [];

  for (let i = 0; i < recipients.length; i += MAX_ACCOUNTS) {
    const batch = recipients.slice(i, i + MAX_ACCOUNTS);
    const batchAmounts = amounts.slice(i, i + MAX_ACCOUNTS);

    const sig = await mintTo(rpc, payer, mint, batch, authority, batchAmounts);
    signatures.push(sig);

    // Add delay between batches
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return signatures;
}
```

### Error: "Compute budget exceeded"

**Cause:** Transaction requires more compute units than default.

**Solution:** Add compute budget instructions.

```typescript
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400000, // Increase as needed
});

const tx = new Transaction()
  .add(modifyComputeUnits)
  .add(...yourInstructions);
```

### Error: "Blockhash expired"

**Cause:** Transaction took too long to confirm.

**Solution:** Use fresh blockhash and retry.

```typescript
async function sendWithRetry(tx, signers, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { blockhash } = await rpc.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      return await sendAndConfirmTransaction(rpc, tx, signers);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
```

---

## Indexer Issues

### Error: "Indexer is stale"

**Cause:** The compression indexer is behind the current slot.

**Solution:** Wait or check indexer health.

```typescript
async function waitForIndexer(maxWait = 30000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const health = await rpc.getIndexerHealth();
      if (health.status === "ok") return true;
    } catch {
      // Indexer still catching up
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return false;
}
```

### Compressed accounts not appearing after mint/transfer

**Cause:** Indexer hasn't processed the transaction yet.

**Solution:** Wait for indexer to catch up.

```typescript
async function waitForAccount(rpc, owner, mint, maxWait = 10000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
    if (accounts.items.length > 0) {
      return accounts.items;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error("Timeout waiting for account");
}

// Usage
await mintTo(rpc, payer, mint, recipient, authority, amount);
const accounts = await waitForAccount(rpc, recipient, mint);
```

---

## SDK Issues

### Error: "Cannot find module '@lightprotocol/stateless.js'"

**Cause:** SDK not installed or wrong package name.

**Solution:** Install the correct packages.

```bash
npm install @lightprotocol/stateless.js @lightprotocol/compressed-token
```

### Error: "Module not found" after installation

**Cause:** Using old package versions or caching issues.

**Solution:** Clear cache and reinstall.

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

### TypeScript errors with SDK types

**Cause:** Type definitions mismatch.

**Solution:** Ensure TypeScript is configured correctly.

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true
  }
}
```

---

## Environment Setup

### Devnet Setup

```bash
# Install CLI
npm install -g @lightprotocol/zk-compression-cli

# Start local test validator with ZK Compression
light test-validator

# Airdrop SOL on devnet
solana airdrop 2 YOUR_WALLET_ADDRESS --url devnet
```

### Required Environment Variables

```bash
# .env
RPC_ENDPOINT=https://devnet.helius-rpc.com?api-key=YOUR_KEY
PHOTON_ENDPOINT=https://devnet.helius-rpc.com?api-key=YOUR_KEY
PRIVATE_KEY=[1,2,3,...] # JSON array of secret key bytes
# OR
WALLET_PATH=./keypair.json
```

---

## Getting Help

If you're still stuck:

1. **Check the official docs**: [zkcompression.com](https://www.zkcompression.com)
2. **Search GitHub issues**: [github.com/Lightprotocol/light-protocol/issues](https://github.com/Lightprotocol/light-protocol/issues)
3. **Join Discord**: [Light Protocol Discord](https://discord.gg/lightprotocol)
4. **Helius support**: [discord.gg/helius](https://discord.gg/helius) for RPC-related issues
