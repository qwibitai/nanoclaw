# DFlow Troubleshooting Guide

Common issues and solutions when integrating DFlow.

## Quote Issues

### "No route found"

**Symptoms:**
- Empty `routePlan` in response
- 500 error from quote endpoint

**Causes:**
1. Token pair has no liquidity
2. Amount too large for available liquidity
3. Amount too small (dust)
4. All DEXes excluded

**Solutions:**

```typescript
// Check if tokens are supported
const tokens = await fetch(`${API_BASE}/tokens`).then(r => r.json());
if (!tokens.includes(inputMint) || !tokens.includes(outputMint)) {
  throw new Error("Token not supported");
}

// Try smaller amount
const smallerAmount = BigInt(amount) / 10n;

// Try with fewer restrictions
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint,
  outputMint,
  amount: smallerAmount.toString(),
  // Remove excludeDexes
  // Remove onlyDirectRoutes
})}`, { headers }).then(r => r.json());
```

### High Price Impact

**Symptoms:**
- `priceImpactPct` > 5%
- Poor execution compared to expected

**Solutions:**

```typescript
// Check price impact before executing
const quote = await getQuote(params);
const impact = parseFloat(quote.priceImpactPct);

if (impact > 1) {
  console.warn(`Price impact: ${impact}%`);
}

if (impact > 5) {
  // Consider splitting into smaller trades
  const numTrades = Math.ceil(impact / 2);
  const amountPerTrade = BigInt(params.amount) / BigInt(numTrades);

  for (let i = 0; i < numTrades; i++) {
    await executeTrade({ ...params, amount: amountPerTrade.toString() });
    await sleep(1000); // Allow price to recover
  }
}
```

## Transaction Errors

### "Transaction expired"

**Symptoms:**
- Transaction fails to land
- `BlockhashNotFound` error

**Causes:**
1. Transaction took too long to sign/send
2. Network congestion
3. Low priority fee

**Solutions:**

```typescript
// 1. Use fresh blockhash
async function sendWithFreshBlockhash(
  transaction: VersionedTransaction,
  keypair: Keypair
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");

  transaction.message.recentBlockhash = blockhash;
  transaction.sign([keypair]);

  const signature = await connection.sendTransaction(transaction);

  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  return signature;
}

// 2. Use higher priority fee
const swap = await getSwapTransaction({
  ...params,
  prioritizationFeeLamports: "high", // or specific number
});

// 3. Use preflight skip for faster submission (risky)
const signature = await connection.sendTransaction(transaction, {
  skipPreflight: true,
  maxRetries: 5,
});
```

### "Slippage exceeded"

**Symptoms:**
- Transaction simulation fails
- "Slippage tolerance exceeded" error

**Causes:**
1. Price moved between quote and execution
2. Slippage tolerance too tight
3. MEV/sandwich attack

**Solutions:**

```typescript
// 1. Use auto slippage
const quote = await getQuote({
  ...params,
  slippageBps: "auto",
});

// 2. Increase slippage for volatile pairs
const volatileTokens = ["BONK", "WIF", "POPCAT"];
const isVolatile = volatileTokens.some(t =>
  params.inputMint.includes(t) || params.outputMint.includes(t)
);

const slippage = isVolatile ? 200 : 50; // 2% vs 0.5%

// 3. Use declarative swaps for better protection
const intent = await getIntentQuote(params);
// Routes optimized at execution time
```

### "Insufficient balance"

**Symptoms:**
- Transaction simulation fails
- "Insufficient funds" error

**Solutions:**

```typescript
// Check balance before swap
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";

async function checkBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey,
  requiredAmount: bigint
): Promise<boolean> {
  // For SOL
  if (mint.equals(WRAPPED_SOL_MINT)) {
    const balance = await connection.getBalance(wallet);
    // Reserve some for fees
    return BigInt(balance) >= requiredAmount + 10000000n;
  }

  // For SPL tokens
  const ata = await getAssociatedTokenAddress(mint, wallet);
  try {
    const account = await getAccount(connection, ata);
    return account.amount >= requiredAmount;
  } catch {
    return false;
  }
}
```

### "Compute budget exceeded"

**Symptoms:**
- Transaction fails with compute error
- Works in simulation but fails on-chain

**Solutions:**

```typescript
// Use dynamic compute limit
const swap = await getSwapTransaction({
  ...params,
  dynamicComputeUnitLimit: true,
});

// Or request higher limit manually
const swap = await fetch(`${API_BASE}/swap-instructions`, {
  method: "POST",
  body: JSON.stringify(params),
}).then(r => r.json());

// Add compute budget instruction
const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: swap.computeUnitLimit * 1.5, // 50% buffer
});
```

## Async Order Issues

### Order stuck in "pending"

**Symptoms:**
- Status never changes from `pending`
- Order not found after long time

**Causes:**
1. Transaction didn't land
2. Indexing delay
3. Transaction expired before landing

**Solutions:**

```typescript
// 1. Verify transaction landed
const status = await connection.getSignatureStatus(signature);
if (!status.value) {
  // Transaction not found - retry
  return await retrySwap(params);
}

// 2. Wait longer for indexing
async function waitForIndexing(signature: string, maxWaitMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = await getOrderStatus(signature);
    if (status.status !== "pending") {
      return status;
    }
    await sleep(3000);
  }

  throw new Error("Order not indexed");
}
```

### Order "failed" status

**Symptoms:**
- Order status is `failed`
- Funds may be in escrow

**Causes:**
1. Fill transaction failed
2. Route became invalid
3. Slippage exceeded during fill

**Solutions:**

```typescript
// Check for reverts
const status = await getOrderStatus(signature);

if (status.status === "failed") {
  // Check if funds returned
  if (status.reverts?.length) {
    console.log("Funds reverted:", status.reverts);
    // Funds should be back in wallet
  } else {
    // May need manual intervention
    console.error("Order failed without revert");
  }
}
```

## API Errors

### 429 Rate Limited

**Solutions:**

```typescript
// 1. Use API key
const headers = { "x-api-key": process.env.DFLOW_API_KEY };

// 2. Implement rate limiting
class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private lastRequest = 0;
  private minInterval = 100; // ms between requests

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const waitTime = Math.max(0, this.lastRequest + this.minInterval - now);

    await sleep(waitTime);
    this.lastRequest = Date.now();

    return fn();
  }
}

// 3. Cache quotes
const quoteCache = new Map<string, { quote: any; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds

async function getCachedQuote(params: QuoteParams) {
  const key = JSON.stringify(params);
  const cached = quoteCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.quote;
  }

  const quote = await getQuote(params);
  quoteCache.set(key, { quote, timestamp: Date.now() });
  return quote;
}
```

### 503 Service Unavailable

**Causes:**
1. System starting up
2. AMM map loading
3. Temporary outage

**Solutions:**

```typescript
async function waitForService(maxWaitMs = 60000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_BASE}/venues`);
      if (res.ok) return true;
    } catch {}

    await sleep(5000);
  }

  return false;
}

// Usage
if (!await waitForService()) {
  throw new Error("DFlow service unavailable");
}
```

## Debugging Tips

### Enable Verbose Logging

```typescript
async function debuggedFetch(url: string, options?: RequestInit) {
  console.log(`[DFlow] Request: ${options?.method || "GET"} ${url}`);

  if (options?.body) {
    console.log(`[DFlow] Body: ${options.body}`);
  }

  const start = Date.now();
  const response = await fetch(url, options);
  const duration = Date.now() - start;

  console.log(`[DFlow] Response: ${response.status} (${duration}ms)`);

  if (!response.ok) {
    const error = await response.text();
    console.error(`[DFlow] Error: ${error}`);
    throw new Error(error);
  }

  return response;
}
```

### Simulate Before Sending

```typescript
async function simulateAndSend(
  connection: Connection,
  transaction: VersionedTransaction
) {
  // Simulate first
  const simulation = await connection.simulateTransaction(transaction);

  if (simulation.value.err) {
    console.error("Simulation failed:", simulation.value.err);
    console.error("Logs:", simulation.value.logs);
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  console.log("Simulation successful");
  console.log("Compute units:", simulation.value.unitsConsumed);

  // Send after successful simulation
  return connection.sendTransaction(transaction);
}
```

### Check Transaction Details

```typescript
async function inspectTransaction(base64Tx: string) {
  const buffer = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(buffer);

  console.log("Transaction details:");
  console.log("  Version:", tx.version);
  console.log("  Signatures needed:", tx.message.header.numRequiredSignatures);
  console.log("  Account keys:", tx.message.staticAccountKeys.length);

  // For v0 transactions
  if (tx.message.addressTableLookups) {
    console.log("  Lookup tables:", tx.message.addressTableLookups.length);
  }
}
```
