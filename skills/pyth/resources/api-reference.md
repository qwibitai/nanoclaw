# Pyth Network API Reference

Complete API reference for Pyth Network SDKs.

## TypeScript SDKs

### @pythnetwork/hermes-client

The recommended SDK for fetching Pyth prices off-chain.

#### Installation

```bash
npm install @pythnetwork/hermes-client
```

#### HermesClient

```typescript
import { HermesClient } from "@pythnetwork/hermes-client";

const client = new HermesClient(endpoint: string, options?: HermesClientOptions);
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| endpoint | `string` | Yes | Hermes API endpoint URL |
| options | `HermesClientOptions` | No | Client configuration |

**HermesClientOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| timeout | `number` | 10000 | Request timeout in ms |

#### Methods

##### getLatestPriceUpdates

Fetch latest price updates for multiple feeds.

```typescript
const updates = await client.getLatestPriceUpdates(
  priceIds: string[],
  options?: GetLatestPriceUpdatesOptions
): Promise<PriceUpdates>;
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| priceIds | `string[]` | Yes | Array of hex price feed IDs |
| options | `object` | No | Request options |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| parsed | `boolean` | true | Include parsed price data |
| encoding | `string` | "hex" | Binary data encoding |

**Returns:** `PriceUpdates`

```typescript
interface PriceUpdates {
  binary: {
    encoding: string;
    data: string[];
  };
  parsed: ParsedPriceUpdate[];
}

interface ParsedPriceUpdate {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}
```

**Example:**

```typescript
const client = new HermesClient("https://hermes.pyth.network");

const updates = await client.getLatestPriceUpdates([
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
]);

for (const update of updates.parsed) {
  console.log(`Feed: ${update.id}`);
  console.log(`Price: ${update.price.price} × 10^${update.price.expo}`);
  console.log(`Confidence: ±${update.price.conf}`);
}
```

##### getPriceUpdatesStream

Subscribe to real-time price updates via Server-Sent Events.

```typescript
const eventSource = await client.getPriceUpdatesStream(
  priceIds: string[],
  options?: StreamOptions
): Promise<EventSource>;
```

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| priceIds | `string[]` | Yes | Array of hex price feed IDs |
| options | `StreamOptions` | No | Stream configuration |

**StreamOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| parsed | `boolean` | true | Include parsed data |
| allowUnordered | `boolean` | false | Allow out-of-order updates |
| benchmarksOnly | `boolean` | false | Only benchmark prices |

**Example:**

```typescript
const eventSource = await client.getPriceUpdatesStream([
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
], { parsed: true });

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Price update:", data);
};

eventSource.onerror = (error) => {
  console.error("Stream error:", error);
  eventSource.close();
};

// Close when done
eventSource.close();
```

---

### @pythnetwork/pyth-solana-receiver

SDK for posting Pyth prices to Solana.

#### Installation

```bash
npm install @pythnetwork/pyth-solana-receiver
```

#### PythSolanaReceiver

```typescript
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

const pythReceiver = new PythSolanaReceiver({
  connection: Connection,
  wallet: Keypair | Wallet,
});
```

#### Methods

##### newTransactionBuilder

Create a transaction builder for posting price updates.

```typescript
const builder = pythReceiver.newTransactionBuilder(
  options?: TransactionBuilderOptions
): PythTransactionBuilder;
```

**TransactionBuilderOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| shardId | `number` | 0 | Shard ID for price accounts |
| closeUpdateAccounts | `boolean` | true | Close accounts after use |

##### PythTransactionBuilder Methods

###### addPostPriceUpdates

Add price update instructions to the transaction.

```typescript
await builder.addPostPriceUpdates(
  priceUpdateData: string[]
): Promise<void>;
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| priceUpdateData | `string[]` | Binary price update data from Hermes |

###### addPriceConsumerInstructions

Add instructions that consume the price.

```typescript
builder.addPriceConsumerInstructions(
  getInstructions: (accounts: PriceAccounts) => TransactionInstruction[]
): void;
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| getInstructions | `function` | Function returning instructions |

**PriceAccounts:**

```typescript
interface PriceAccounts {
  priceUpdateAccounts: PublicKey[];
}
```

###### buildVersionedTransactions

Build versioned transactions.

```typescript
const transactions = await builder.buildVersionedTransactions(
  options?: BuildOptions
): Promise<VersionedTransaction[]>;
```

**BuildOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| computeUnitPriceMicroLamports | `number` | 0 | Priority fee |
| tightComputeBudget | `boolean` | false | Use tight compute budget |

**Example:**

```typescript
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";

const hermesClient = new HermesClient("https://hermes.pyth.network");
const pythReceiver = new PythSolanaReceiver({ connection, wallet });

// Fetch prices
const priceUpdates = await hermesClient.getLatestPriceUpdates([
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
]);

// Build transaction
const builder = pythReceiver.newTransactionBuilder();
await builder.addPostPriceUpdates(priceUpdates.binary.data);

builder.addPriceConsumerInstructions(({ priceUpdateAccounts }) => {
  return [
    // Your instruction that uses priceUpdateAccounts[0]
  ];
});

const transactions = await builder.buildVersionedTransactions({
  computeUnitPriceMicroLamports: 50000,
});

// Send transactions
for (const tx of transactions) {
  const sig = await connection.sendTransaction(tx);
  console.log("Signature:", sig);
}
```

---

## Rust SDK

### pyth-solana-receiver-sdk

SDK for consuming Pyth prices in Solana programs.

#### Installation

Add to `Cargo.toml`:

```toml
[dependencies]
pyth-solana-receiver-sdk = "0.3.0"
anchor-lang = "0.30.1"
```

#### Types

##### PriceUpdateV2

The main account type for price updates.

```rust
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

#[derive(Accounts)]
pub struct MyInstruction<'info> {
    pub price_update: Account<'info, PriceUpdateV2>,
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| write_authority | `Pubkey` | Account authorized to write |
| verification_level | `VerificationLevel` | Price verification level |
| price_message | `PriceFeedMessage` | The price data |
| posted_slot | `u64` | Slot when posted |

##### Price

Price data structure.

```rust
pub struct Price {
    pub price: i64,      // Price value
    pub conf: u64,       // Confidence interval
    pub exponent: i32,   // Scaling exponent
    pub publish_time: i64, // Publish timestamp
}
```

#### Methods

##### get_price_no_older_than

Get price with staleness check.

```rust
impl PriceUpdateV2 {
    pub fn get_price_no_older_than(
        &self,
        clock: &Clock,
        max_age_secs: u64,
    ) -> Result<Price>;
}
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| clock | `&Clock` | Solana clock sysvar |
| max_age_secs | `u64` | Maximum age in seconds |

**Returns:** `Result<Price>` - Price or error if too old

**Example:**

```rust
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

pub fn use_price(ctx: Context<UsePrice>) -> Result<()> {
    let price_update = &ctx.accounts.price_update;
    let clock = Clock::get()?;

    let price = price_update.get_price_no_older_than(&clock, 60)?;

    msg!("Price: {} × 10^{}", price.price, price.exponent);
    msg!("Confidence: ±{}", price.conf);

    Ok(())
}
```

##### get_price_no_older_than_with_custom_verification

Get price with feed ID verification.

```rust
impl PriceUpdateV2 {
    pub fn get_price_no_older_than_with_custom_verification(
        &self,
        clock: &Clock,
        max_age_secs: u64,
        feed_id: &FeedId,
        expected_owner: &Pubkey,
    ) -> Result<Price>;
}
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| clock | `&Clock` | Solana clock sysvar |
| max_age_secs | `u64` | Maximum age in seconds |
| feed_id | `&FeedId` | Expected feed ID |
| expected_owner | `&Pubkey` | Expected account owner |

**Example:**

```rust
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, get_feed_id_from_hex};

const BTC_USD_FEED: &str = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

pub fn verified_price(ctx: Context<VerifiedPrice>) -> Result<()> {
    let price_update = &ctx.accounts.price_update;
    let clock = Clock::get()?;

    let feed_id = get_feed_id_from_hex(BTC_USD_FEED)?;

    let price = price_update.get_price_no_older_than_with_custom_verification(
        &clock,
        60,
        &feed_id,
        &pyth_solana_receiver_sdk::ID,
    )?;

    Ok(())
}
```

##### get_ema_price_no_older_than

Get EMA price with staleness check.

```rust
impl PriceUpdateV2 {
    pub fn get_ema_price_no_older_than(
        &self,
        clock: &Clock,
        max_age_secs: u64,
    ) -> Result<Price>;
}
```

**Example:**

```rust
let ema_price = price_update.get_ema_price_no_older_than(&clock, 60)?;
msg!("EMA Price: {}", ema_price.price);
```

#### Helper Functions

##### get_feed_id_from_hex

Convert hex string to FeedId.

```rust
use pyth_solana_receiver_sdk::price_update::get_feed_id_from_hex;

let feed_id = get_feed_id_from_hex(
    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"
)?;
```

#### Error Codes

| Error | Description |
|-------|-------------|
| `PriceTooOld` | Price exceeds max age |
| `FeedIdMismatch` | Feed ID doesn't match |
| `InvalidOwner` | Account owner invalid |
| `InsufficientVerification` | Verification level too low |

---

## Hermes HTTP API

### Endpoints

Base URL: `https://hermes.pyth.network`

#### GET /v2/updates/price/latest

Fetch latest prices for multiple feeds.

**Query Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| ids[] | `string` | Yes | Price feed IDs (can repeat) |
| encoding | `string` | No | Response encoding (hex/base64) |
| parsed | `boolean` | No | Include parsed data |

**Example:**

```bash
curl "https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43&parsed=true"
```

**Response:**

```json
{
  "binary": {
    "encoding": "hex",
    "data": ["..."]
  },
  "parsed": [
    {
      "id": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      "price": {
        "price": "6789000000000",
        "conf": "3500000000",
        "expo": -8,
        "publish_time": 1705320000
      },
      "ema_price": {
        "price": "6785000000000",
        "conf": "3200000000",
        "expo": -8,
        "publish_time": 1705320000
      }
    }
  ]
}
```

#### GET /v2/updates/price/stream

Stream real-time price updates via SSE.

**Query Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| ids[] | `string` | Yes | Price feed IDs |
| parsed | `boolean` | No | Include parsed data |
| allow_unordered | `boolean` | No | Allow out-of-order |

**Example:**

```bash
curl -N "https://hermes.pyth.network/v2/updates/price/stream?ids[]=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43&parsed=true"
```

---

## Price Calculation

### Converting Fixed-Point to Display

```typescript
function toDisplayPrice(price: string, expo: number): number {
  return Number(price) * Math.pow(10, expo);
}

// Example: price="6789000000000", expo=-8
// Result: 67890.00000000 → $67,890.00
```

### Safe Price Bounds

```typescript
function getSafeBounds(price: number, conf: number) {
  return {
    lower: price - conf,
    upper: price + conf,
    // 95% confidence interval (2 standard deviations)
    lower95: price - 2 * conf,
    upper95: price + 2 * conf,
  };
}
```

### Confidence Validation

```typescript
function isConfidenceAcceptable(
  price: number,
  conf: number,
  maxRatioBps: number = 200 // 2%
): boolean {
  const ratioBps = (conf / Math.abs(price)) * 10000;
  return ratioBps <= maxRatioBps;
}
```

---

## Rate Limits

### Public Hermes Endpoint

| Limit Type | Value |
|------------|-------|
| Requests/second | 10 |
| Concurrent connections | 5 |
| Feeds per request | 100 |

> For higher limits, use a dedicated endpoint from a Pyth data provider.
