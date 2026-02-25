# Switchboard Troubleshooting Guide

Common issues and solutions when integrating Switchboard Oracle Protocol.

## Table of Contents

- [Connection Issues](#connection-issues)
- [Feed Update Errors](#feed-update-errors)
- [Oracle Response Issues](#oracle-response-issues)
- [Transaction Errors](#transaction-errors)
- [Staleness Issues](#staleness-issues)
- [SDK Issues](#sdk-issues)
- [Surge Streaming Issues](#surge-streaming-issues)

---

## Connection Issues

### Error: "Program not found" or "Account not found"

**Cause:** Using wrong program ID for the network.

**Solution:** Ensure you're using the correct program ID:

```typescript
import {
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";

// Use correct PID based on network
const programId = network === "mainnet"
  ? ON_DEMAND_MAINNET_PID
  : ON_DEMAND_DEVNET_PID;
```

### Error: "Failed to connect to RPC"

**Cause:** RPC endpoint is unavailable or rate-limited.

**Solution:**
1. Use a dedicated RPC endpoint (Helius, QuickNode, etc.)
2. Implement retry logic:

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## Feed Update Errors

### Error: "No oracle responses received"

**Cause:** Oracles didn't respond to the update request.

**Solutions:**

1. **Reduce signature requirements:**
```typescript
const { pullIx } = await feedAccount.fetchUpdateIx({
  numSignatures: 1,  // Reduce from default
});
```

2. **Check feed configuration:**
   - Verify the feed exists in Feed Builder
   - Ensure the feed hash is correct

3. **Retry with backoff:**
```typescript
let result;
for (let i = 0; i < 3; i++) {
  try {
    result = await feedAccount.fetchUpdateIx({...});
    break;
  } catch (error) {
    await sleep(2000 * (i + 1));
  }
}
```

### Error: "Invalid feed pubkey"

**Cause:** The feed public key doesn't correspond to a valid feed account.

**Solution:**
1. Verify the feed exists on the correct network
2. Double-check the pubkey string:

```typescript
// Validate pubkey
try {
  const feedPubkey = new web3.PublicKey(feedPubkeyString);
} catch {
  throw new Error("Invalid public key format");
}
```

### Error: "Crossbar request failed"

**Cause:** Unable to communicate with Crossbar service.

**Solution:**
1. Check network connectivity
2. Use correct Crossbar endpoint:

```typescript
const crossbar = new CrossbarClient("https://crossbar.switchboard.xyz");
```

3. Implement timeout handling:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);

try {
  const result = await feedAccount.fetchUpdateIx({...});
} finally {
  clearTimeout(timeout);
}
```

---

## Oracle Response Issues

### Error: "Insufficient oracle responses"

**Cause:** Not enough oracles responded to meet minimum requirements.

**Solutions:**

1. **Lower requirements:**
```typescript
const { pullIx, numSuccess } = await feedAccount.fetchUpdateIx({
  numSignatures: 1,  // Minimum
});

if (numSuccess < 1) {
  throw new Error("No responses");
}
```

2. **Check oracle queue health** - Oracles may be temporarily unavailable

3. **Try again later** - Transient network issues can affect oracle responses

### Error: "Quote verification failed"

**Cause:** The oracle quote couldn't be verified cryptographically.

**Solution:** Ensure secp256k1 instruction is properly included:

```rust
// Rust: Verify instruction at correct index
let quote = QuoteVerifier::new()
    .queue(&queue)
    .verify_instruction_at(0)  // Must match instruction index
    .unwrap();
```

---

## Transaction Errors

### Error: "Transaction too large"

**Cause:** Too many instructions or accounts in transaction.

**Solutions:**

1. **Use lookup tables:**
```typescript
const { pullIx, luts } = await feedAccount.fetchUpdateIx({...});

const tx = await asV0Tx({
  connection,
  ixs: [pullIx],
  lookupTables: luts,  // Use provided lookup tables
  signers: [payer],
});
```

2. **Split into multiple transactions**

### Error: "Compute budget exceeded"

**Cause:** Transaction requires more compute units than allocated.

**Solution:** Increase compute budget:

```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 600_000,  // Increase as needed
});

const tx = new Transaction()
  .add(modifyComputeUnits)
  .add(pullIx);
```

### Error: "Blockhash expired"

**Cause:** Transaction took too long to confirm.

**Solution:** Use fresh blockhash and retry:

```typescript
async function sendWithRetry(tx, signers) {
  for (let i = 0; i < 3; i++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      return await connection.sendTransaction(tx, signers);
    } catch (error) {
      if (!error.message.includes("expired")) throw error;
      // Retry with new blockhash
    }
  }
}
```

### Error: "Insufficient funds"

**Cause:** Wallet doesn't have enough SOL for transaction fees.

**Solution:** Check and fund wallet:

```typescript
const balance = await connection.getBalance(wallet.publicKey);
if (balance < 0.01 * web3.LAMPORTS_PER_SOL) {
  throw new Error("Insufficient SOL balance");
}
```

---

## Staleness Issues

### Error: "Feed is stale" (program-side)

**Cause:** Feed hasn't been updated recently enough.

**Solutions:**

1. **Update feed before reading:**
```typescript
// Update first
await client.updateFeed(feedPubkey);
// Then read
const value = await client.readFeed(feedPubkey);
```

2. **Adjust staleness threshold:**
```rust
// Rust: Allow more staleness if acceptable
const MAX_STALENESS: u64 = 200; // Increase from 100
let staleness = current_slot.saturating_sub(feed_slot);
require!(staleness < MAX_STALENESS, ErrorCode::StaleFeed);
```

3. **Use Oracle Quotes** - They don't store on-chain and are always fresh

### Detecting staleness in TypeScript

```typescript
async function checkFeedFreshness(feedPubkey: PublicKey): Promise<boolean> {
  const feed = new PullFeed(program, feedPubkey);
  const data = await feed.loadData();
  const currentSlot = await connection.getSlot();
  const staleness = currentSlot - data.lastUpdatedSlot;

  return staleness < 100; // Less than ~40 seconds
}
```

---

## SDK Issues

### Error: "Cannot find module '@switchboard-xyz/on-demand'"

**Cause:** Package not installed.

**Solution:**

```bash
npm install @switchboard-xyz/on-demand @switchboard-xyz/common
```

### Error: "Type errors with SDK"

**Cause:** TypeScript configuration issues.

**Solution:** Update tsconfig.json:

```json
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

### Error: "AnchorProvider is not a constructor"

**Cause:** Import issue with Anchor.

**Solution:** Use correct imports:

```typescript
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// NOT from "@project-serum/anchor" (deprecated)
```

---

## Surge Streaming Issues

### Error: "WebSocket connection failed"

**Cause:** Unable to connect to Surge WebSocket.

**Solutions:**

1. **Check endpoint:**
```typescript
const surge = new SwitchboardSurge({
  gatewayUrl: "wss://surge.switchboard.xyz",  // Correct endpoint
});
```

2. **Enable auto-reconnect:**
```typescript
const surge = new SwitchboardSurge({
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
});
```

### Error: "No data received"

**Cause:** Not subscribed to feeds or invalid feed symbols.

**Solution:**
```typescript
// Subscribe after connection
surge.on("connected", () => {
  surge.subscribe(["SOL/USD", "BTC/USD"]);
});

// Verify subscription
surge.on("error", (err) => {
  console.error("Surge error:", err);
});
```

### Error: "Rate limit exceeded"

**Cause:** Too many requests without API key.

**Solution:** Use API key for higher limits:

```typescript
const surge = new SwitchboardSurge({
  apiKey: process.env.SWITCHBOARD_API_KEY,
});
```

---

## Getting Help

If you're still stuck:

1. **Check official docs**: https://docs.switchboard.xyz
2. **Search GitHub issues**: https://github.com/switchboard-xyz/switchboard/issues
3. **Join Discord**: https://discord.gg/TJAv6ZYvPC
4. **Check examples**: https://github.com/switchboard-xyz/sb-on-demand-examples

---

## Debug Checklist

When debugging Switchboard issues:

- [ ] Correct network (mainnet vs devnet)?
- [ ] Correct program ID for network?
- [ ] Valid feed pubkey/hash?
- [ ] Sufficient SOL balance?
- [ ] RPC endpoint working?
- [ ] Crossbar reachable?
- [ ] Feed exists and is active?
- [ ] Transaction compute budget sufficient?
- [ ] Using latest SDK version?

```bash
# Check SDK version
npm list @switchboard-xyz/on-demand

# Update to latest
npm update @switchboard-xyz/on-demand
```
