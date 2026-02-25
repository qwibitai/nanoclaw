# DFlow Error Handling Guide

Common errors, their causes, and how to handle them.

## HTTP Error Codes

### 400 Bad Request

**Causes:**
- Invalid token mint address
- Amount is zero or negative
- Invalid slippage value
- Malformed request body

**Solutions:**
```typescript
// Validate before sending
function validateSwapParams(params: SwapParams) {
  if (!isValidPublicKey(params.inputMint)) {
    throw new Error("Invalid input mint");
  }
  if (!isValidPublicKey(params.outputMint)) {
    throw new Error("Invalid output mint");
  }
  if (params.amount <= 0) {
    throw new Error("Amount must be positive");
  }
  if (params.slippageBps < 0 || params.slippageBps > 10000) {
    throw new Error("Slippage must be 0-10000 bps");
  }
}
```

### 401 Unauthorized

**Causes:**
- Missing API key
- Invalid API key
- Expired API key

**Solutions:**
```typescript
const headers = {
  "x-api-key": process.env.DFLOW_API_KEY,
};

if (!headers["x-api-key"]) {
  console.warn("No API key provided - rate limits apply");
}
```

### 404 Not Found

**Causes:**
- Order/signature doesn't exist
- Invalid endpoint path

**Solutions:**
```typescript
async function getOrderStatus(signature: string) {
  const res = await fetch(`${API_BASE}/order-status?signature=${signature}`);

  if (res.status === 404) {
    // Order not found - may not be indexed yet
    return { status: "not_found" };
  }

  return res.json();
}
```

### 429 Rate Limited

**Causes:**
- Too many requests without API key
- Exceeded API key limits

**Solutions:**
```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") || "5";
      await new Promise(r => setTimeout(r, parseInt(retryAfter) * 1000));
      continue;
    }

    return res;
  }
  throw new Error("Rate limit exceeded after retries");
}
```

### 500 Internal Server Error

**Causes:**
- Route computation failed
- Server-side error

**Solutions:**
```typescript
async function getQuoteWithFallback(params: QuoteParams) {
  try {
    return await getQuote(params);
  } catch (error) {
    if (error.status === 500) {
      // Try with simplified parameters
      return await getQuote({
        ...params,
        onlyDirectRoutes: true,
        maxRouteLength: 2,
      });
    }
    throw error;
  }
}
```

### 503 Service Unavailable

**Causes:**
- AMM map not initialized
- Service starting up
- System lagging

**Solutions:**
```typescript
async function waitForService(maxWaitMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_BASE}/venues`);
      if (res.ok) return true;
    } catch {}

    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error("Service unavailable");
}
```

## Quote Errors

### No Route Found

**Causes:**
- Token pair has no liquidity
- Amount too small/large
- All venues excluded

**Detection:**
```typescript
const quote = await getQuote(params);

if (!quote.routePlan || quote.routePlan.length === 0) {
  throw new Error("No route available for this swap");
}
```

**Solutions:**
- Try smaller amount
- Remove DEX exclusions
- Check if tokens are supported

### High Price Impact

**Detection:**
```typescript
const quote = await getQuote(params);
const impactPct = parseFloat(quote.priceImpactPct);

if (impactPct > 5) {
  console.warn(`High price impact: ${impactPct}%`);
}

if (impactPct > 10) {
  throw new Error("Price impact too high - consider smaller amount");
}
```

### Insufficient Liquidity

**Detection:**
```typescript
// Compare expected vs actual output
const expectedRate = getExpectedRate(inputMint, outputMint);
const actualRate = parseFloat(quote.outAmount) / parseFloat(quote.inAmount);
const slippage = (expectedRate - actualRate) / expectedRate * 100;

if (slippage > 5) {
  console.warn("High slippage detected - low liquidity");
}
```

## Transaction Errors

### Slippage Exceeded

**Causes:**
- Price moved during execution
- Slippage tolerance too tight

**Solutions:**
```typescript
// Use auto slippage
const quote = await getQuote({
  ...params,
  slippageBps: "auto",
});

// Or increase manually
const quote = await getQuote({
  ...params,
  slippageBps: 100, // 1%
});
```

### Transaction Expired

**Causes:**
- Transaction not sent in time
- Network congestion

**Solutions:**
```typescript
async function sendWithRetry(transaction: VersionedTransaction, keypair: Keypair) {
  const maxRetries = 3;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Get fresh blockhash if expired
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();

      transaction.message.recentBlockhash = blockhash;
      transaction.sign([keypair]);

      const signature = await connection.sendTransaction(transaction);
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      return signature;
    } catch (error) {
      if (error.message.includes("expired") && i < maxRetries - 1) {
        continue;
      }
      throw error;
    }
  }
}
```

### Insufficient Balance

**Detection:**
```typescript
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

async function checkBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey,
  requiredAmount: bigint
) {
  const ata = await getAssociatedTokenAddress(mint, wallet);

  try {
    const account = await getAccount(connection, ata);
    if (account.amount < requiredAmount) {
      throw new Error(`Insufficient balance: have ${account.amount}, need ${requiredAmount}`);
    }
  } catch (error) {
    if (error.name === "TokenAccountNotFoundError") {
      throw new Error("Token account not found");
    }
    throw error;
  }
}
```

### Compute Budget Exceeded

**Causes:**
- Complex route requires more CUs
- Fixed CU limit too low

**Solutions:**
```typescript
const swap = await fetch(`${API_BASE}/swap`, {
  method: "POST",
  body: JSON.stringify({
    ...params,
    dynamicComputeUnitLimit: true, // Let server calculate
  }),
});
```

## Order Status Errors

### Order Failed

**Causes:**
- Fill transaction failed
- Route became invalid

**Detection:**
```typescript
async function handleOrderStatus(signature: string) {
  const status = await getOrderStatus(signature);

  switch (status.status) {
    case "closed":
      return { success: true, ...status };

    case "failed":
      return {
        success: false,
        error: "Order execution failed",
        reverts: status.reverts
      };

    case "expired":
      return {
        success: false,
        error: "Order expired - retry with higher priority fee"
      };

    default:
      return { pending: true, status: status.status };
  }
}
```

### Order Not Found

**Causes:**
- Signature incorrect
- Order not yet indexed
- Order never submitted

**Solutions:**
```typescript
async function getOrderStatusWithRetry(signature: string) {
  // Wait for indexing
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API_BASE}/order-status?signature=${signature}`);

    if (res.status === 404) {
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    return res.json();
  }

  throw new Error("Order not found after retries");
}
```

## Comprehensive Error Handler

```typescript
class DFlowError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = "DFlowError";
  }
}

async function handleDFlowRequest<T>(
  requestFn: () => Promise<Response>
): Promise<T> {
  const response = await requestFn();

  if (!response.ok) {
    const errorBody = await response.text();

    switch (response.status) {
      case 400:
        throw new DFlowError(
          "Invalid request parameters",
          "BAD_REQUEST",
          errorBody
        );
      case 401:
        throw new DFlowError(
          "Authentication failed",
          "UNAUTHORIZED"
        );
      case 404:
        throw new DFlowError(
          "Resource not found",
          "NOT_FOUND"
        );
      case 429:
        throw new DFlowError(
          "Rate limit exceeded",
          "RATE_LIMITED"
        );
      case 500:
        throw new DFlowError(
          "Server error - try again",
          "SERVER_ERROR",
          errorBody
        );
      case 503:
        throw new DFlowError(
          "Service unavailable",
          "SERVICE_UNAVAILABLE"
        );
      default:
        throw new DFlowError(
          `Request failed: ${response.status}`,
          "UNKNOWN",
          errorBody
        );
    }
  }

  return response.json();
}

// Usage
try {
  const quote = await handleDFlowRequest<QuoteResponse>(() =>
    fetch(`${API_BASE}/quote?${params}`, { headers })
  );
} catch (error) {
  if (error instanceof DFlowError) {
    switch (error.code) {
      case "RATE_LIMITED":
        // Wait and retry
        break;
      case "BAD_REQUEST":
        // Fix parameters
        break;
      default:
        // Log and report
        break;
    }
  }
}
```
