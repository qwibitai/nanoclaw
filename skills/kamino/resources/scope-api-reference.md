# Scope Oracle SDK (scope-sdk) API Reference

Complete API reference for `@kamino-finance/scope-sdk`.

## Overview

Scope is Kamino's oracle aggregator that provides reliable price data by combining multiple oracle sources including Pyth, Switchboard, TWAP prices, and DEX-derived prices.

## Installation

```bash
npm install @kamino-finance/scope-sdk @solana/web3.js
# or
yarn add @kamino-finance/scope-sdk @solana/web3.js
```

## Core Class: Scope

Main entry point for oracle interactions.

### Constructor

```typescript
import { Scope } from "@kamino-finance/scope-sdk";
import { Connection, clusterApiUrl } from "@solana/web3.js";

const connection = new Connection(clusterApiUrl("mainnet-beta"));
const scope = new Scope("mainnet-beta", connection);
```

### Constructor Parameters

```typescript
constructor(
  cluster: SolanaCluster,              // "mainnet-beta" | "devnet"
  connection: Connection,
  scopeConfig?: PublicKey,             // Optional custom config
  scopeProgramId?: PublicKey           // Optional custom program ID
)
```

## Price Retrieval Methods

### Get All Oracle Prices

```typescript
// Get all available prices
const prices = await scope.getOraclePrices();

// Access individual prices
for (const [token, priceData] of prices.entries()) {
  console.log(`${token}: $${priceData.price.toString()}`);
}

// Get specific token price
const solPrice = prices.get("SOL");
const usdcPrice = prices.get("USDC");
```

### Get Single Price

```typescript
// Get price for specific token
const priceData = await scope.getPrice("SOL");

console.log("Price:", priceData.price.toString());
console.log("Timestamp:", priceData.timestamp);
console.log("Confidence:", priceData.confidence);
console.log("Exponent:", priceData.exponent);
```

### Get Price with Metadata

```typescript
// Get price with source information
const priceWithMeta = await scope.getPriceWithMetadata("SOL");

console.log("Price:", priceWithMeta.price);
console.log("Source:", priceWithMeta.source);        // "PYTH", "SWITCHBOARD", etc.
console.log("Age (slots):", priceWithMeta.ageSlots);
console.log("Confidence:", priceWithMeta.confidence);
console.log("Status:", priceWithMeta.status);        // "TRADING", "HALTED", etc.
```

### Get Multiple Prices

```typescript
// Get prices for multiple tokens
const tokens = ["SOL", "USDC", "BONK", "JitoSOL"];
const prices = await scope.getPrices(tokens);

for (const [token, price] of Object.entries(prices)) {
  console.log(`${token}: $${price.toString()}`);
}
```

## Methods Reference

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getOraclePrices` | `()` | `Promise<Map<string, OraclePrice>>` | All oracle prices |
| `getPrice` | `token: string` | `Promise<OraclePrice>` | Single token price |
| `getPriceWithMetadata` | `token: string` | `Promise<OraclePriceWithMeta>` | Price with source info |
| `getPrices` | `tokens: string[]` | `Promise<Record<string, Decimal>>` | Multiple prices |
| `getPriceByMint` | `mint: PublicKey` | `Promise<OraclePrice>` | Price by token mint |
| `refreshPrices` | `()` | `Promise<void>` | Refresh price cache |
| `getOracleMapping` | `()` | `Promise<OracleMapping>` | Get token-to-oracle mapping |

## Type Definitions

### OraclePrice

```typescript
interface OraclePrice {
  price: Decimal;              // Current price
  timestamp: number;           // Unix timestamp (seconds)
  confidence: Decimal;         // Price confidence interval
  exponent: number;            // Price exponent/decimals
  slot: number;                // Solana slot of price update
}
```

### OraclePriceWithMeta

```typescript
interface OraclePriceWithMeta extends OraclePrice {
  source: OracleSource;        // Price source
  ageSlots: number;            // Age in slots
  status: PriceStatus;         // Price feed status
  mintAddress: PublicKey;      // Token mint address
  oracleAddress: PublicKey;    // Oracle account address
}
```

### OracleSource

```typescript
type OracleSource =
  | "PYTH"           // Pyth Network oracle
  | "SWITCHBOARD"    // Switchboard oracle
  | "TWAP"           // Time-weighted average price
  | "CLMM"           // CLMM DEX-derived price
  | "SCOPE"          // Scope-derived price
  | "MANUAL";        // Manually set price
```

### PriceStatus

```typescript
type PriceStatus =
  | "TRADING"        // Normal trading, price valid
  | "HALTED"         // Trading halted
  | "UNKNOWN"        // Status unknown
  | "AUCTION"        // In auction phase
  | "IGNORED";       // Price should be ignored
```

### OracleMapping

```typescript
interface OracleMapping {
  tokens: Map<string, TokenOracleInfo>;
  mints: Map<string, TokenOracleInfo>;
}

interface TokenOracleInfo {
  symbol: string;
  mint: PublicKey;
  oracleAddress: PublicKey;
  oracleType: OracleSource;
  decimals: number;
}
```

## Oracle Configuration

### Get Configuration

```typescript
// Get scope configuration
const config = await scope.getConfiguration();

console.log("Config address:", config.address);
console.log("Admin:", config.admin);
console.log("Oracle mappings:", config.oracleMappings.length);
```

### Configuration Interface

```typescript
interface ScopeConfiguration {
  address: PublicKey;
  admin: PublicKey;
  oracleMappings: OracleMappingEntry[];
  oracleTwaps: OracleTwapEntry[];
  oraclePrices: PublicKey;
}

interface OracleMappingEntry {
  tokenIndex: number;
  priceType: OracleSource;
  priceAccount: PublicKey;
  twapEnabled: boolean;
  twapSource: number;
}
```

## Price Feed Sources

### Pyth Integration

Scope integrates with Pyth Network for real-time market prices:

```typescript
// Prices from Pyth have high-frequency updates
const pythPrice = await scope.getPriceWithMetadata("SOL");
if (pythPrice.source === "PYTH") {
  console.log("Pyth price:", pythPrice.price);
  console.log("Confidence:", pythPrice.confidence);  // Pyth confidence interval
}
```

### Switchboard Integration

Switchboard provides decentralized oracle feeds:

```typescript
// Some tokens may use Switchboard
const sbPrice = await scope.getPriceWithMetadata("BONK");
if (sbPrice.source === "SWITCHBOARD") {
  console.log("Switchboard price:", sbPrice.price);
}
```

### TWAP Prices

Time-weighted average prices for reduced volatility:

```typescript
// TWAP prices are averaged over time
const twapPrice = await scope.getTwapPrice("SOL");
console.log("TWAP price:", twapPrice.price);
console.log("Period:", twapPrice.period);  // Averaging period in slots
```

### DEX-Derived Prices

Prices derived from concentrated liquidity pools:

```typescript
// CLMM-derived prices from Orca/Raydium
const clmmPrice = await scope.getClmmPrice("BONK");
console.log("CLMM price:", clmmPrice.price);
console.log("Pool:", clmmPrice.poolAddress);
```

## TWAP Methods

```typescript
// Get TWAP price
const twapPrice = await scope.getTwapPrice("SOL");

// Get TWAP with configuration
const twapConfig = await scope.getTwapConfig("SOL");
console.log("TWAP period:", twapConfig.period);
console.log("TWAP source:", twapConfig.source);

// Get all TWAP prices
const allTwaps = await scope.getAllTwapPrices();
```

### TWAP Types

```typescript
interface TwapPrice extends OraclePrice {
  period: number;              // Averaging period in slots
  numSamples: number;          // Number of samples in average
  lastSampleSlot: number;      // Last sample slot
}

interface TwapConfig {
  tokenIndex: number;
  period: number;
  source: OracleSource;
  enabled: boolean;
}
```

## Utility Methods

### Price Staleness Check

```typescript
// Check if price is stale
const priceData = await scope.getPriceWithMetadata("SOL");
const currentSlot = await connection.getSlot();
const ageSlots = currentSlot - priceData.slot;

const MAX_STALE_SLOTS = 100;  // ~40 seconds
if (ageSlots > MAX_STALE_SLOTS) {
  console.warn("Price may be stale:", ageSlots, "slots old");
}
```

### Price Confidence Check

```typescript
// Check price confidence
const priceData = await scope.getPriceWithMetadata("SOL");
const confidenceRatio = priceData.confidence.div(priceData.price);

const MAX_CONFIDENCE_RATIO = 0.01;  // 1% confidence
if (confidenceRatio.gt(MAX_CONFIDENCE_RATIO)) {
  console.warn("Price confidence too wide:", confidenceRatio.toString());
}
```

### Convert Price to USD

```typescript
// Convert token amount to USD value
function toUsdValue(
  tokenAmount: Decimal,
  price: Decimal,
  tokenDecimals: number
): Decimal {
  return tokenAmount.div(new Decimal(10).pow(tokenDecimals)).mul(price);
}

const solAmount = new Decimal(1_000_000_000);  // 1 SOL
const solPrice = await scope.getPrice("SOL");
const usdValue = toUsdValue(solAmount, solPrice.price, 9);
console.log("USD value:", usdValue.toString());
```

## Supported Tokens

Common tokens supported by Scope:

| Symbol | Description | Primary Source |
|--------|-------------|----------------|
| SOL | Solana | Pyth |
| USDC | USD Coin | Pyth |
| USDT | Tether | Pyth |
| BTC | Bitcoin (Wrapped) | Pyth |
| ETH | Ethereum (Wrapped) | Pyth |
| BONK | Bonk | Switchboard/CLMM |
| JitoSOL | Jito Staked SOL | CLMM |
| mSOL | Marinade Staked SOL | CLMM |
| BSOL | BlazeStake SOL | CLMM |
| JTO | Jito | Pyth |
| PYTH | Pyth | Pyth |
| RAY | Raydium | CLMM |
| ORCA | Orca | CLMM |

## Error Handling

```typescript
import { ScopeError } from "@kamino-finance/scope-sdk";

try {
  const price = await scope.getPrice("UNKNOWN_TOKEN");
} catch (error) {
  if (error instanceof ScopeError) {
    switch (error.code) {
      case "TOKEN_NOT_FOUND":
        console.error("Token not supported by Scope");
        break;
      case "STALE_PRICE":
        console.error("Price feed is stale");
        break;
      case "ORACLE_ERROR":
        console.error("Oracle returned error:", error.message);
        break;
      default:
        console.error("Scope error:", error.message);
    }
  } else {
    throw error;
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `TOKEN_NOT_FOUND` | Token not in Scope mapping |
| `STALE_PRICE` | Price hasn't updated recently |
| `ORACLE_ERROR` | Underlying oracle error |
| `INVALID_PRICE` | Price is zero or invalid |
| `CONFIG_NOT_FOUND` | Scope configuration not found |

## Integration with Kamino

Scope is used internally by other Kamino SDKs:

```typescript
import { Kamino } from "@kamino-finance/kliquidity-sdk";
import { Scope } from "@kamino-finance/scope-sdk";

const scope = new Scope("mainnet-beta", connection);
const kamino = new Kamino("mainnet-beta", connection);

// Get oracle prices for share data calculation
const oraclePrices = await scope.getOraclePrices();

// Use in strategy share calculation
const shareData = await kamino.getStrategyShareData(
  strategy,
  oraclePrices  // Pass Scope prices
);
```

## Constants

```typescript
import {
  SCOPE_PROGRAM_ID,
  SCOPE_CONFIG_MAINNET,
  SCOPE_CONFIG_DEVNET,
  DEFAULT_ORACLE_MAPPINGS,
  MAX_PRICE_AGE_SLOTS
} from "@kamino-finance/scope-sdk";
```

## Best Practices

### Caching Prices

```typescript
class PriceCache {
  private cache: Map<string, { price: OraclePrice; timestamp: number }>;
  private maxAge: number;

  constructor(maxAgeMs: number = 5000) {
    this.cache = new Map();
    this.maxAge = maxAgeMs;
  }

  async getPrice(scope: Scope, token: string): Promise<OraclePrice> {
    const cached = this.cache.get(token);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.maxAge) {
      return cached.price;
    }

    const price = await scope.getPrice(token);
    this.cache.set(token, { price, timestamp: now });
    return price;
  }
}
```

### Handling Multiple Price Sources

```typescript
async function getBestPrice(
  scope: Scope,
  token: string
): Promise<OraclePriceWithMeta> {
  const priceWithMeta = await scope.getPriceWithMetadata(token);

  // Check price validity
  if (priceWithMeta.status !== "TRADING") {
    throw new Error(`Price status: ${priceWithMeta.status}`);
  }

  // Check staleness
  if (priceWithMeta.ageSlots > 100) {
    console.warn("Using potentially stale price");
  }

  // Check confidence
  const confidenceRatio = priceWithMeta.confidence.div(priceWithMeta.price);
  if (confidenceRatio.gt(0.02)) {
    console.warn("Wide confidence interval:", confidenceRatio.toString());
  }

  return priceWithMeta;
}
```
