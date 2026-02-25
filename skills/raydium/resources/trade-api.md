# Raydium Trade API Reference

The Trade API enables routing swaps through Raydium's routing engine via HTTP endpoints.

## Base URLs

```typescript
const TRADE_API = "https://transaction-v1.raydium.io";
const DATA_API = "https://api-v3.raydium.io";
```

---

## Swap Endpoints

### GET /compute/swap-base-in

Get a quote for swapping tokens (input amount specified).

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | string | Yes | Source token mint address |
| `outputMint` | string | Yes | Destination token mint address |
| `amount` | string | Yes | Input amount in base units (lamports) |
| `slippageBps` | number | Yes | Slippage tolerance (50 = 0.5%) |
| `txVersion` | string | Yes | `V0` or `LEGACY` |

**Example Request:**

```typescript
const params = new URLSearchParams({
  inputMint: "So11111111111111111111111111111111111111112", // SOL
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  amount: "1000000000", // 1 SOL
  slippageBps: "50", // 0.5%
  txVersion: "V0",
});

const response = await fetch(
  `https://transaction-v1.raydium.io/compute/swap-base-in?${params}`
);
const quote = await response.json();
```

**Response:**

```json
{
  "id": "quote-uuid",
  "success": true,
  "data": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "inAmount": "1000000000",
    "outAmount": "150432100",
    "otherAmountThreshold": "149679039",
    "priceImpactPct": "0.0234",
    "routePlan": [
      {
        "poolId": "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
        "inputMint": "So11...",
        "outputMint": "EPjF...",
        "feeMint": "EPjF...",
        "feeRate": 0.0025,
        "feeAmount": "376080"
      }
    ]
  }
}
```

---

### GET /compute/swap-base-out

Get a quote for swapping tokens (output amount specified).

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | string | Yes | Source token mint address |
| `outputMint` | string | Yes | Destination token mint address |
| `amount` | string | Yes | Desired output amount in base units |
| `slippageBps` | number | Yes | Slippage tolerance |
| `txVersion` | string | Yes | `V0` or `LEGACY` |

**Example:**

```typescript
// Get quote to receive exactly 100 USDC
const params = new URLSearchParams({
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "100000000", // 100 USDC (6 decimals)
  slippageBps: "50",
  txVersion: "V0",
});

const response = await fetch(
  `https://transaction-v1.raydium.io/compute/swap-base-out?${params}`
);
```

---

### POST /transaction/swap-base-in

Serialize a swap transaction from a quote.

**Request Body:**

```typescript
interface SwapTransactionRequest {
  swapResponse: QuoteResponse; // Response from /compute/swap-base-in
  wallet: string; // User's public key
  txVersion: "V0" | "LEGACY";
  wrapSol?: boolean; // Wrap native SOL (default: true)
  unwrapSol?: boolean; // Unwrap to native SOL (default: true)
  inputAccount?: string; // Custom input token account
  outputAccount?: string; // Custom output token account
  computeUnitPriceMicroLamports?: string; // Priority fee
}
```

**Example:**

```typescript
const transactionResponse = await fetch(
  "https://transaction-v1.raydium.io/transaction/swap-base-in",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      swapResponse: quote.data,
      wallet: userPublicKey.toBase58(),
      txVersion: "V0",
      wrapSol: true,
      unwrapSol: true,
      computeUnitPriceMicroLamports: "100000", // Priority fee
    }),
  }
);

const { data } = await transactionResponse.json();
// data contains serialized transaction(s)
```

**Response:**

```json
{
  "id": "tx-uuid",
  "success": true,
  "data": [
    {
      "transaction": "base64-encoded-transaction..."
    }
  ]
}
```

---

### POST /transaction/swap-base-out

Serialize a swap transaction for exact output amount.

Same request body as `/transaction/swap-base-in`, but uses the quote from `/compute/swap-base-out`.

---

## Priority Fees

### GET /main/auto-fee

Get recommended priority fees based on network conditions.

**Example:**

```typescript
const feeResponse = await fetch("https://api-v3.raydium.io/main/auto-fee");
const fees = await feeResponse.json();
```

**Response:**

```json
{
  "id": "fee-uuid",
  "success": true,
  "data": {
    "default": {
      "vh": 500000,    // Very high priority
      "h": 200000,     // High priority
      "m": 100000      // Medium priority
    }
  }
}
```

---

## Complete Swap Example

```typescript
import {
  Connection,
  Keypair,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const TRADE_API = "https://transaction-v1.raydium.io";
const FEE_API = "https://api-v3.raydium.io/main/auto-fee";

// Token addresses
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function swapWithTradeAPI(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string, // In base units
  slippageBps: number = 50
) {
  // Step 1: Get priority fee
  const feeRes = await fetch(FEE_API);
  const feeData = await feeRes.json();
  const priorityFee = feeData.data.default.h; // High priority

  // Step 2: Get quote
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
    txVersion: "V0",
  });

  const quoteRes = await fetch(`${TRADE_API}/compute/swap-base-in?${quoteParams}`);
  const quote = await quoteRes.json();

  if (!quote.success) {
    throw new Error(`Quote failed: ${quote.msg}`);
  }

  console.log("Quote received:");
  console.log(`  Input: ${Number(quote.data.inAmount) / 1e9} SOL`);
  console.log(`  Output: ${Number(quote.data.outAmount) / 1e6} USDC`);
  console.log(`  Price impact: ${quote.data.priceImpactPct}%`);

  // Step 3: Get serialized transaction
  const txRes = await fetch(`${TRADE_API}/transaction/swap-base-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      swapResponse: quote.data,
      wallet: keypair.publicKey.toBase58(),
      txVersion: "V0",
      wrapSol: true,
      unwrapSol: true,
      computeUnitPriceMicroLamports: priorityFee.toString(),
    }),
  });

  const txData = await txRes.json();

  if (!txData.success) {
    throw new Error(`Transaction build failed: ${txData.msg}`);
  }

  // Step 4: Deserialize, sign, and send
  const transactions = txData.data;

  for (const txInfo of transactions) {
    const tx = VersionedTransaction.deserialize(
      Buffer.from(txInfo.transaction, "base64")
    );
    tx.sign([keypair]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log(`Transaction sent: ${signature}`);

    await connection.confirmTransaction(signature, "confirmed");
    console.log(`Confirmed: https://solscan.io/tx/${signature}`);
  }

  return quote.data.outAmount;
}

// Usage
async function main() {
  const connection = new Connection(process.env.RPC_URL!);
  const keypair = Keypair.fromSecretKey(
    bs58.decode(process.env.PRIVATE_KEY!)
  );

  // Swap 1 SOL for USDC
  const outAmount = await swapWithTradeAPI(
    connection,
    keypair,
    SOL,
    USDC,
    "1000000000" // 1 SOL
  );

  console.log(`Received: ${Number(outAmount) / 1e6} USDC`);
}

main().catch(console.error);
```

---

## Error Handling

```typescript
interface APIResponse<T> {
  id: string;
  success: boolean;
  msg?: string; // Error message if success is false
  data?: T;
}

async function safeApiCall<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result: APIResponse<T> = await response.json();

  if (!result.success) {
    throw new Error(result.msg || "API request failed");
  }

  return result.data!;
}
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `No route found` | No liquidity path exists | Try different token pair or smaller amount |
| `Slippage exceeded` | Price moved beyond tolerance | Increase slippageBps or retry |
| `Invalid mint` | Unknown token address | Verify mint address is correct |
| `Transaction simulation failed` | Insufficient balance or other issue | Check balances, compute units |

---

## Rate Limits

- Public endpoints are rate limited
- Use reasonable request intervals (1-2 seconds between requests)
- For production, consider caching quotes briefly

---

## Transaction Version Comparison

| Version | Description | Use Case |
|---------|-------------|----------|
| `V0` | Versioned transactions with address lookup tables | Recommended for most cases |
| `LEGACY` | Legacy transaction format | Compatibility with older wallets |

---

## Additional Endpoints

### Pool Data

```typescript
// Get pool info by ID
const pool = await fetch(
  `https://api-v3.raydium.io/pools/info/ids?ids=${poolId}`
);

// Get pools by token pair
const pools = await fetch(
  `https://api-v3.raydium.io/pools/info/mint?mint1=${mint1}&mint2=${mint2}`
);

// Get pool list
const poolList = await fetch(
  "https://api-v3.raydium.io/pools/info/list?pageSize=100&page=1"
);
```

### Token Data

```typescript
// Get token list
const tokens = await fetch("https://api-v3.raydium.io/mint/list");

// Get token prices
const prices = await fetch(
  `https://api-v3.raydium.io/mint/price?mints=${mint1},${mint2}`
);
```
