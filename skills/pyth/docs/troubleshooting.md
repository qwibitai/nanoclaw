# Pyth Network Troubleshooting Guide

Common issues and solutions when working with Pyth Network oracles.

---

## Off-Chain (Hermes API) Issues

### "Price Not Found" Error

**Problem**: API returns empty or no data for a feed ID.

**Solutions**:

1. Verify the feed ID is correct:
```typescript
// Feed IDs must include 0x prefix and be 66 characters
const feedId = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
console.log("Feed ID length:", feedId.length); // Should be 66
console.log("Has 0x prefix:", feedId.startsWith("0x")); // Should be true
```

2. Check feed ID on Pyth website:
   - Visit https://pyth.network/developers/price-feed-ids
   - Search for your asset
   - Copy the exact feed ID

3. Test with curl:
```bash
curl "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
```

---

### Rate Limit Exceeded

**Problem**: API returns 429 Too Many Requests.

**Solutions**:

1. Implement rate limiting:
```typescript
const rateLimiter = {
  lastRequest: 0,
  minInterval: 100, // 10 requests per second max

  async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }
};

// Use before each request
await rateLimiter.throttle();
const prices = await client.getLatestPriceUpdates(feedIds);
```

2. Batch multiple feeds into single requests:
```typescript
// BAD - multiple requests
for (const feedId of feedIds) {
  await client.getLatestPriceUpdates([feedId]);
}

// GOOD - single request for all
await client.getLatestPriceUpdates(feedIds);
```

3. Use a dedicated Hermes endpoint for production.

---

### Connection Timeout

**Problem**: Hermes API requests timeout.

**Solutions**:

1. Set appropriate timeout:
```typescript
const client = new HermesClient("https://hermes.pyth.network", {
  timeout: 15000, // 15 seconds
});
```

2. Implement retry logic:
```typescript
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * 1000;
      console.log(`Retry ${i + 1} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Max retries exceeded");
}
```

3. Check Pyth Network status: https://status.pyth.network

---

### SSE Stream Disconnecting

**Problem**: Real-time price stream keeps disconnecting.

**Solutions**:

1. Handle reconnection:
```typescript
function createReconnectingStream(
  feedIds: string[],
  onPrice: (data: any) => void
): { stop: () => void } {
  let eventSource: EventSource | null = null;
  let shouldRun = true;

  async function connect() {
    if (!shouldRun) return;

    const client = new HermesClient("https://hermes.pyth.network");
    eventSource = await client.getPriceUpdatesStream(feedIds, { parsed: true });

    eventSource.onmessage = (event) => {
      onPrice(JSON.parse(event.data));
    };

    eventSource.onerror = () => {
      console.log("Stream error, reconnecting in 5s...");
      eventSource?.close();
      setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    stop: () => {
      shouldRun = false;
      eventSource?.close();
    }
  };
}
```

2. Check network stability and firewall settings.

---

## On-Chain (Solana) Issues

### "PriceTooOld" Error

**Problem**: Anchor program returns `PriceTooOld` error.

**Solutions**:

1. Increase max age or fetch fresher prices:
```rust
// Option 1: Increase max age
let price = price_update.get_price_no_older_than(&clock, 120)?; // 2 minutes

// Option 2: Fetch fresher price before transaction
```

2. Check Solana clock vs publish time:
```rust
let current_time = clock.unix_timestamp;
let price_age = current_time - price.publish_time;
msg!("Price age: {}s", price_age);
```

3. Ensure price update is posted before consuming:
```typescript
// Post price, then immediately consume in same transaction
const builder = pythReceiver.newTransactionBuilder();
await builder.addPostPriceUpdates(priceData);
builder.addPriceConsumerInstructions(({ priceUpdateAccounts }) => {
  return [yourInstruction(priceUpdateAccounts[0])];
});
```

---

### "FeedIdMismatch" Error

**Problem**: Expected feed ID doesn't match the price update account.

**Solutions**:

1. Verify feed ID format:
```rust
// Ensure hex string includes 0x prefix
const EXPECTED_FEED: &str = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

let feed_id = get_feed_id_from_hex(EXPECTED_FEED)?;
```

2. Check the correct price account is passed:
```typescript
// Log the accounts being used
console.log("Price update account:", priceUpdateAccount.toString());
console.log("Expected feed ID:", feedId);
```

3. Use explicit verification:
```rust
let price = price_update.get_price_no_older_than_with_custom_verification(
    &clock,
    60,
    &expected_feed_id,
    &pyth_solana_receiver_sdk::ID, // Verify owner too
)?;
```

---

### "InsufficientVerification" Error

**Problem**: Price update verification level is too low.

**Solutions**:

1. Check verification level:
```rust
msg!("Verification level: {:?}", price_update.verification_level);

// VerificationLevel::Partial - faster but less secure
// VerificationLevel::Full - slower but fully verified
```

2. Use partial verification for dev, full for production:
```typescript
// For mainnet, ensure full verification
const updates = await client.getLatestPriceUpdates(feedIds, {
  encoding: "hex",
  // Hermes returns fully verified data by default
});
```

---

### "Account Not Found" Error

**Problem**: Price update account doesn't exist.

**Solutions**:

1. Ensure account is created before consuming:
```typescript
// Build and send post transaction first
const postTx = await builder.addPostPriceUpdates(priceData);
const transactions = await builder.buildVersionedTransactions();

for (const tx of transactions) {
  await connection.sendTransaction(tx);
}

// Now the price account exists
```

2. Check account derivation:
```typescript
// Price accounts are derived from the price data
// They're temporary and closed after use by default
```

3. Set `closeUpdateAccounts: false` to keep accounts:
```typescript
const builder = pythReceiver.newTransactionBuilder({
  closeUpdateAccounts: false, // Keep accounts for later use
});
```

---

### Compute Budget Exceeded

**Problem**: Transaction fails with compute budget error.

**Solutions**:

1. Increase compute budget:
```typescript
import { ComputeBudgetProgram } from "@solana/web3.js";

const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400_000, // Increase as needed
});

// Add as first instruction
transaction.add(computeIx, ...otherInstructions);
```

2. Split into multiple transactions:
```typescript
// Post prices in one transaction
const builder1 = pythReceiver.newTransactionBuilder({
  closeUpdateAccounts: false, // Keep for second tx
});
await builder1.addPostPriceUpdates(priceData);

// Consume in second transaction
// Pass the price accounts to your program
```

---

## Price Interpretation Issues

### Incorrect Price Calculation

**Problem**: Calculated price doesn't match expected value.

**Solutions**:

1. Remember prices use fixed-point:
```typescript
// Price = value × 10^exponent
// Example: price=6789000000000, expo=-8
// Actual: 6789000000000 × 10^(-8) = 67890.00

function toPrice(value: string, expo: number): number {
  return Number(value) * Math.pow(10, expo);
}
```

2. Handle decimal precision carefully:
```rust
// In Rust, use i128 for intermediate calculations
let price_value = price.price as i128;
let token_amount = amount as i128;

// Adjust for decimals
let result = (price_value * token_amount) / 10i128.pow(precision);
```

---

### Confidence Interval Too Wide

**Problem**: Price confidence is larger than expected.

**Solutions**:

1. Check market conditions (high volatility = wider confidence).

2. Implement confidence validation:
```typescript
function isConfidenceAcceptable(price: number, conf: number, maxBps: number = 200): boolean {
  const confBps = (conf / Math.abs(price)) * 10000;
  return confBps <= maxBps;
}

if (!isConfidenceAcceptable(priceData.price, priceData.conf)) {
  console.warn("Confidence too wide, waiting for better data...");
}
```

3. Use EMA price for smoother values:
```typescript
const updates = await client.getLatestPriceUpdates(feedIds);
const emaPrice = updates.parsed[0].ema_price;
// EMA has lower variance than spot price
```

---

### Negative or Zero Price

**Problem**: Price is zero or negative.

**Solutions**:

1. Always validate prices:
```rust
require!(price.price > 0, OracleError::InvalidPrice);
```

2. Handle edge cases:
```typescript
if (priceData.price <= 0) {
  throw new Error(`Invalid price: ${priceData.price}`);
}

// For some assets (like funding rates), negative is valid
// Check the specific feed's expected range
```

---

## SDK Installation Issues

### Package Not Found

**Problem**: npm can't find @pythnetwork packages.

**Solutions**:

1. Check package name spelling:
```bash
# Correct names:
npm install @pythnetwork/hermes-client
npm install @pythnetwork/pyth-solana-receiver
```

2. Clear npm cache:
```bash
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

---

### TypeScript Type Errors

**Problem**: TypeScript doesn't recognize Pyth types.

**Solutions**:

1. Install type definitions:
```bash
npm install --save-dev @types/node
```

2. Check tsconfig.json:
```json
{
  "compilerOptions": {
    "esModuleInterop": true,
    "moduleResolution": "node",
    "target": "ES2020"
  }
}
```

---

### Rust Compilation Errors

**Problem**: `pyth-solana-receiver-sdk` won't compile.

**Solutions**:

1. Check Anchor version compatibility:
```toml
[dependencies]
anchor-lang = "0.30.1"
pyth-solana-receiver-sdk = "0.3.0"
```

2. Update Rust toolchain:
```bash
rustup update stable
cargo update
```

---

## Debugging Tips

### Enable Verbose Logging

```typescript
// Log all API requests
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  console.log("[Pyth] Request:", url);
  const start = Date.now();
  const response = await originalFetch(url, options);
  console.log(`[Pyth] Response: ${response.status} (${Date.now() - start}ms)`);
  return response;
};
```

### Verify Price Account Data

```typescript
async function debugPriceAccount(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address);

  if (!info) {
    console.log("Account does not exist");
    return;
  }

  console.log("Owner:", info.owner.toString());
  console.log("Lamports:", info.lamports);
  console.log("Data length:", info.data.length);
}
```

### Check Pyth Status

```bash
# Test Hermes connectivity
curl -s "https://hermes.pyth.network/api/latest_price_feeds" | jq '.[] | .id' | head -5

# Check specific feed
curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" | jq '.parsed[0]'
```

---

## Getting Help

1. **Pyth Documentation**: https://docs.pyth.network
2. **Price Feed IDs**: https://pyth.network/developers/price-feed-ids
3. **GitHub Issues**: https://github.com/pyth-network/pyth-crosschain/issues
4. **Discord**: https://discord.gg/pythnetwork
5. **Network Status**: https://status.pyth.network
