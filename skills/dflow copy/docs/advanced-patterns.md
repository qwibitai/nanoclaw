# Advanced DFlow Integration Patterns

Advanced patterns for production DFlow integrations.

## Platform Fee Collection

Collect fees on swaps facilitated through your platform:

```typescript
// 1. Get quote with platform fee
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  platformFeeBps: "50", // 0.5% fee
  platformFeeMode: "outputMint", // Collect fee in output token
})}`, { headers }).then(r => r.json());

// 2. Create swap with fee account
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    feeAccount: platformFeeAccount.toBase58(), // Your token account
  }),
}).then(r => r.json());

// Fee is automatically deducted from output and sent to feeAccount
```

### Fee Account Setup

```typescript
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

async function setupFeeAccount(
  connection: Connection,
  payer: Keypair,
  tokenMint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(tokenMint, owner);

  // Check if account exists
  const accountInfo = await connection.getAccountInfo(ata);

  if (!accountInfo) {
    // Create ATA for fee collection
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      tokenMint
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }

  return ata;
}
```

## Gasless/Sponsored Swaps

Allow users to swap without holding SOL for fees:

```typescript
// Sponsor pays transaction fees
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    sponsor: sponsorWallet.toBase58(), // Sponsor's public key
    sponsoredSwap: true, // Account for Token2022 fees
  }),
}).then(r => r.json());

// Transaction requires both user AND sponsor signatures
const tx = VersionedTransaction.deserialize(
  Buffer.from(swap.swapTransaction, "base64")
);

// Sign with user first
tx.sign([userKeypair]);

// Then sponsor signs
tx.sign([sponsorKeypair]);

// Sponsor submits (they pay the SOL fees)
await connection.sendTransaction(tx);
```

## Custom Destination Accounts

Send output tokens to a different wallet:

```typescript
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    destinationTokenAccount: {
      address: recipientAta.toBase58(),
      createIfNeeded: true, // Create ATA if doesn't exist
    },
  }),
}).then(r => r.json());
```

## Jito Bundle Integration

For MEV protection and priority:

```typescript
// 1. Get Jito-compatible quote
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  forJitoBundle: "true", // Only Jito-compatible routes
})}`, { headers }).then(r => r.json());

// 2. Add Jito tip
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    prioritizationFeeLamports: {
      jitoTipLamports: 10000, // Tip for Jito searchers
    },
    includeJitoSandwichMitigationAccount: true, // Extra protection
  }),
}).then(r => r.json());

// 3. Submit via Jito
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";

const client = searcherClient("https://mainnet.block-engine.jito.wtf");
const bundle = [tx];
await client.sendBundle(bundle);
```

## Positive Slippage Handling

Capture price improvements:

```typescript
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
    positiveSlippage: {
      mode: "split", // Split extra between user and platform
      bps: 5000, // 50% to platform, 50% to user
    },
  }),
}).then(r => r.json());
```

## DEX Routing Control

Fine-grained control over which DEXes to use:

```typescript
// Only use specific DEXes
const quote = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  dexes: "raydium,orca", // Only these
})}`, { headers }).then(r => r.json());

// Exclude specific DEXes
const quote2 = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  excludeDexes: "phoenix", // All except these
})}`, { headers }).then(r => r.json());

// Direct routes only (single hop)
const quote3 = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  onlyDirectRoutes: "true",
})}`, { headers }).then(r => r.json());

// Limit route complexity
const quote4 = await fetch(`${API_BASE}/quote?${new URLSearchParams({
  inputMint: SOL,
  outputMint: USDC,
  amount: "1000000000",
  maxRouteLength: "3", // Max 3 hops
})}`, { headers }).then(r => r.json());
```

## Transaction Instruction Extraction

Build custom transactions with DFlow swap instructions:

```typescript
// Get instructions instead of full transaction
const instructions = await fetch(`${API_BASE}/swap-instructions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    userPublicKey: user.toBase58(),
    quoteResponse: quote,
  }),
}).then(r => r.json());

// Build custom transaction
const message = new TransactionMessage({
  payerKey: user,
  recentBlockhash: blockhash,
  instructions: [
    // Your pre-swap instructions
    createMemoInstruction("My swap"),

    // DFlow swap instructions
    ...instructions.instructions.map(ix => new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map(a => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    })),

    // Your post-swap instructions
    createCloseAccountInstruction(...),
  ],
}).compileToV0Message(instructions.addressLookupTableAddresses.map(
  addr => lookupTables.get(addr)
));

const tx = new VersionedTransaction(message);
```

## Retry Logic with Exponential Backoff

Production-ready retry handling:

```typescript
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
  }
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry certain errors
      if (
        error.message.includes("insufficient") ||
        error.message.includes("invalid")
      ) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt),
        config.maxDelayMs
      );

      // Add jitter
      const jitter = Math.random() * delay * 0.1;
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }

  throw lastError!;
}

// Usage
const result = await executeWithRetry(async () => {
  const quote = await getQuote(params);
  const swap = await getSwapTransaction(quote, user);
  return signAndSend(swap, keypair);
});
```

## Rate Limit Handling

Handle API rate limits gracefully:

```typescript
class RateLimitedClient {
  private requestQueue: Array<() => Promise<any>> = [];
  private processing = false;
  private requestsThisMinute = 0;
  private minuteStart = Date.now();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number = 60) {
    this.maxPerMinute = maxPerMinute;
  }

  async request<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.requestQueue.length > 0) {
      // Reset counter if minute passed
      if (Date.now() - this.minuteStart > 60000) {
        this.requestsThisMinute = 0;
        this.minuteStart = Date.now();
      }

      // Wait if at limit
      if (this.requestsThisMinute >= this.maxPerMinute) {
        const waitTime = 60000 - (Date.now() - this.minuteStart);
        await new Promise(r => setTimeout(r, waitTime));
        this.requestsThisMinute = 0;
        this.minuteStart = Date.now();
      }

      const request = this.requestQueue.shift()!;
      this.requestsThisMinute++;
      await request();
    }

    this.processing = false;
  }
}
```

## Webhook Integration

For production systems, use webhooks for order status:

```typescript
// Your webhook endpoint receives status updates
app.post("/webhooks/dflow", async (req, res) => {
  const { orderId, status, signature, inAmount, outAmount } = req.body;

  // Verify webhook signature (implement based on DFlow's spec)
  if (!verifyWebhookSignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  switch (status) {
    case "closed":
      await handleOrderComplete(orderId, { inAmount, outAmount });
      break;
    case "failed":
      await handleOrderFailed(orderId);
      break;
    case "expired":
      await handleOrderExpired(orderId);
      break;
  }

  res.status(200).send("OK");
});
```

## Monitoring & Observability

Track swap performance:

```typescript
import { Histogram, Counter } from "prom-client";

const swapDuration = new Histogram({
  name: "dflow_swap_duration_seconds",
  help: "Time to complete swaps",
  labelNames: ["status", "execution_mode"],
});

const swapCount = new Counter({
  name: "dflow_swaps_total",
  help: "Total swaps executed",
  labelNames: ["status", "input_token", "output_token"],
});

async function monitoredSwap(params: SwapParams) {
  const timer = swapDuration.startTimer();

  try {
    const result = await executeTrade(params);

    timer({ status: "success", execution_mode: result.executionMode });
    swapCount.inc({
      status: "success",
      input_token: params.inputMint,
      output_token: params.outputMint,
    });

    return result;
  } catch (error) {
    timer({ status: "error", execution_mode: "unknown" });
    swapCount.inc({
      status: "error",
      input_token: params.inputMint,
      output_token: params.outputMint,
    });
    throw error;
  }
}
```
