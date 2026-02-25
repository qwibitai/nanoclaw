# Kamino Scope Oracle: Price Feed Examples

Complete examples for using Scope oracle price feeds.

## Setup

```typescript
import { Scope } from "@kamino-finance/scope-sdk";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import Decimal from "decimal.js";

const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
const connection = new Connection(RPC_URL, "confirmed");
const scope = new Scope("mainnet-beta", connection);
```

## Basic Price Retrieval

### Get All Prices

```typescript
async function getAllPrices(): Promise<void> {
  console.log("=== All Oracle Prices ===\n");

  const prices = await scope.getOraclePrices();

  for (const [token, priceData] of prices.entries()) {
    console.log(`${token}:`);
    console.log(`  Price: $${priceData.price.toFixed(6)}`);
    console.log(`  Timestamp: ${new Date(priceData.timestamp * 1000).toISOString()}`);
    console.log(`  Slot: ${priceData.slot}`);
    console.log("");
  }
}
```

### Get Single Token Price

```typescript
async function getTokenPrice(token: string): Promise<Decimal> {
  const priceData = await scope.getPrice(token);

  console.log(`\n=== ${token} Price ===`);
  console.log("Price:", priceData.price.toFixed(6));
  console.log("Confidence:", priceData.confidence.toFixed(6));
  console.log("Timestamp:", new Date(priceData.timestamp * 1000).toISOString());
  console.log("Slot:", priceData.slot);
  console.log("Exponent:", priceData.exponent);

  return priceData.price;
}

// Examples
// await getTokenPrice("SOL");
// await getTokenPrice("USDC");
// await getTokenPrice("BONK");
```

### Get Price with Metadata

```typescript
async function getPriceWithSource(token: string): Promise<void> {
  const priceWithMeta = await scope.getPriceWithMetadata(token);

  console.log(`\n=== ${token} Price with Metadata ===`);
  console.log("Price:", priceWithMeta.price.toFixed(6));
  console.log("Source:", priceWithMeta.source);
  console.log("Status:", priceWithMeta.status);
  console.log("Age (slots):", priceWithMeta.ageSlots);
  console.log("Confidence:", priceWithMeta.confidence.toFixed(6));
  console.log("Mint:", priceWithMeta.mintAddress.toString());
  console.log("Oracle Address:", priceWithMeta.oracleAddress.toString());
}
```

## Multiple Token Prices

```typescript
async function getMultiplePrices(tokens: string[]): Promise<void> {
  console.log("\n=== Multiple Token Prices ===\n");

  const prices = await scope.getPrices(tokens);

  for (const [token, price] of Object.entries(prices)) {
    console.log(`${token}: $${price.toFixed(6)}`);
  }
}

// Example
// await getMultiplePrices(["SOL", "USDC", "BONK", "JitoSOL", "mSOL"]);
```

## Price Validation

### Check Price Freshness

```typescript
async function checkPriceFreshness(
  token: string,
  maxStaleSlots: number = 100
): Promise<boolean> {
  const priceWithMeta = await scope.getPriceWithMetadata(token);
  const currentSlot = await connection.getSlot();

  const ageSlots = currentSlot - priceWithMeta.slot;
  const isFresh = ageSlots <= maxStaleSlots;

  console.log(`\n=== ${token} Price Freshness ===`);
  console.log("Current Slot:", currentSlot);
  console.log("Price Slot:", priceWithMeta.slot);
  console.log("Age (slots):", ageSlots);
  console.log("Max Stale Slots:", maxStaleSlots);
  console.log("Is Fresh:", isFresh);

  if (!isFresh) {
    console.warn(`⚠️ WARNING: ${token} price is ${ageSlots} slots old (${(ageSlots * 0.4).toFixed(1)} seconds)`);
  }

  return isFresh;
}
```

### Check Price Confidence

```typescript
async function checkPriceConfidence(
  token: string,
  maxConfidenceRatio: number = 0.01  // 1%
): Promise<boolean> {
  const priceData = await scope.getPrice(token);

  const confidenceRatio = priceData.confidence.div(priceData.price);
  const isConfident = confidenceRatio.lte(maxConfidenceRatio);

  console.log(`\n=== ${token} Price Confidence ===`);
  console.log("Price:", priceData.price.toFixed(6));
  console.log("Confidence:", priceData.confidence.toFixed(6));
  console.log("Confidence Ratio:", confidenceRatio.mul(100).toFixed(4), "%");
  console.log("Max Allowed:", (maxConfidenceRatio * 100).toFixed(2), "%");
  console.log("Is Confident:", isConfident);

  if (!isConfident) {
    console.warn(`⚠️ WARNING: ${token} price confidence is wide: ${confidenceRatio.mul(100).toFixed(4)}%`);
  }

  return isConfident;
}
```

### Validate Price Before Use

```typescript
async function getValidatedPrice(
  token: string,
  maxStaleSlots: number = 100,
  maxConfidenceRatio: number = 0.02
): Promise<Decimal | null> {
  console.log(`\n=== Validating ${token} Price ===`);

  const priceWithMeta = await scope.getPriceWithMetadata(token);

  // Check status
  if (priceWithMeta.status !== "TRADING") {
    console.error(`❌ Price status is ${priceWithMeta.status}, not TRADING`);
    return null;
  }

  // Check freshness
  if (priceWithMeta.ageSlots > maxStaleSlots) {
    console.error(`❌ Price is stale: ${priceWithMeta.ageSlots} slots old`);
    return null;
  }

  // Check confidence
  const confidenceRatio = priceWithMeta.confidence.div(priceWithMeta.price);
  if (confidenceRatio.gt(maxConfidenceRatio)) {
    console.error(`❌ Price confidence too wide: ${confidenceRatio.mul(100).toFixed(4)}%`);
    return null;
  }

  console.log(`✅ Price validated: $${priceWithMeta.price.toFixed(6)}`);
  return priceWithMeta.price;
}
```

## USD Value Calculations

### Convert Token Amount to USD

```typescript
async function tokenToUsd(
  token: string,
  amount: Decimal,
  decimals: number
): Promise<Decimal> {
  const price = await scope.getPrice(token);

  // Convert from base units to token units, then to USD
  const tokenAmount = amount.div(new Decimal(10).pow(decimals));
  const usdValue = tokenAmount.mul(price.price);

  console.log(`\n${tokenAmount.toFixed(6)} ${token} = $${usdValue.toFixed(2)}`);

  return usdValue;
}

// Example: 1 SOL in USD
// const solLamports = new Decimal(1_000_000_000);  // 1 SOL = 1B lamports
// await tokenToUsd("SOL", solLamports, 9);
```

### Calculate Portfolio Value

```typescript
interface TokenBalance {
  symbol: string;
  amount: Decimal;
  decimals: number;
}

async function calculatePortfolioValue(balances: TokenBalance[]): Promise<Decimal> {
  console.log("\n=== Portfolio Value ===\n");

  let totalValue = new Decimal(0);

  for (const { symbol, amount, decimals } of balances) {
    try {
      const price = await scope.getPrice(symbol);
      const tokenAmount = amount.div(new Decimal(10).pow(decimals));
      const usdValue = tokenAmount.mul(price.price);

      console.log(`${symbol}: ${tokenAmount.toFixed(6)} × $${price.price.toFixed(2)} = $${usdValue.toFixed(2)}`);

      totalValue = totalValue.add(usdValue);
    } catch (error) {
      console.warn(`Could not get price for ${symbol}`);
    }
  }

  console.log("\n────────────────────────────────");
  console.log(`Total Portfolio Value: $${totalValue.toFixed(2)}`);

  return totalValue;
}

// Example
// await calculatePortfolioValue([
//   { symbol: "SOL", amount: new Decimal(5_000_000_000), decimals: 9 },   // 5 SOL
//   { symbol: "USDC", amount: new Decimal(1000_000_000), decimals: 6 },  // 1000 USDC
//   { symbol: "BONK", amount: new Decimal(10_000_000_000_000), decimals: 5 },  // 100M BONK
// ]);
```

## Price Monitoring

### Price Alert System

```typescript
interface PriceAlert {
  token: string;
  condition: "above" | "below";
  threshold: Decimal;
  callback: (token: string, price: Decimal) => void;
}

async function monitorPrices(
  alerts: PriceAlert[],
  intervalMs: number = 10000
): Promise<void> {
  console.log("\n=== Starting Price Monitor ===");
  console.log("Checking every", intervalMs / 1000, "seconds\n");

  for (const alert of alerts) {
    console.log(`Watching ${alert.token} for price ${alert.condition} $${alert.threshold.toFixed(2)}`);
  }

  const checkPrices = async () => {
    for (const alert of alerts) {
      try {
        const price = await scope.getPrice(alert.token);

        const triggered =
          alert.condition === "above"
            ? price.price.gt(alert.threshold)
            : price.price.lt(alert.threshold);

        if (triggered) {
          console.log(`\n🔔 ALERT: ${alert.token} is ${alert.condition} $${alert.threshold.toString()}`);
          console.log(`   Current price: $${price.price.toFixed(6)}`);
          alert.callback(alert.token, price.price);
        }
      } catch (error) {
        console.error(`Error checking ${alert.token}:`, error);
      }
    }
  };

  // Initial check
  await checkPrices();

  // Set up interval
  setInterval(checkPrices, intervalMs);
}

// Example
// await monitorPrices([
//   {
//     token: "SOL",
//     condition: "above",
//     threshold: new Decimal(200),
//     callback: (token, price) => console.log(`${token} mooning!`),
//   },
//   {
//     token: "SOL",
//     condition: "below",
//     threshold: new Decimal(50),
//     callback: (token, price) => console.log(`${token} dumping!`),
//   },
// ]);
```

### Price Change Tracker

```typescript
async function trackPriceChanges(
  tokens: string[],
  intervalMs: number = 60000
): Promise<void> {
  console.log("\n=== Price Change Tracker ===\n");

  const previousPrices = new Map<string, Decimal>();

  const track = async () => {
    console.log(`\n[${new Date().toLocaleTimeString()}]`);

    for (const token of tokens) {
      try {
        const currentPrice = (await scope.getPrice(token)).price;
        const previousPrice = previousPrices.get(token);

        if (previousPrice) {
          const change = currentPrice.sub(previousPrice);
          const changePercent = change.div(previousPrice).mul(100);

          const arrow = change.gt(0) ? "↑" : change.lt(0) ? "↓" : "→";
          const color = change.gt(0) ? "🟢" : change.lt(0) ? "🔴" : "⚪";

          console.log(
            `${color} ${token}: $${currentPrice.toFixed(4)} ${arrow} ${changePercent.toFixed(2)}%`
          );
        } else {
          console.log(`⚪ ${token}: $${currentPrice.toFixed(4)} (baseline)`);
        }

        previousPrices.set(token, currentPrice);
      } catch (error) {
        console.error(`Error tracking ${token}`);
      }
    }
  };

  // Initial baseline
  await track();

  // Set up interval
  setInterval(track, intervalMs);
}

// Example
// await trackPriceChanges(["SOL", "USDC", "BONK", "JitoSOL"], 30000);
```

## TWAP Prices

```typescript
async function getTwapPrice(token: string): Promise<void> {
  console.log(`\n=== ${token} TWAP Price ===`);

  try {
    const twapPrice = await scope.getTwapPrice(token);

    console.log("TWAP Price:", twapPrice.price.toFixed(6));
    console.log("Period:", twapPrice.period, "slots");
    console.log("Samples:", twapPrice.numSamples);
    console.log("Last Sample Slot:", twapPrice.lastSampleSlot);

    // Compare with spot price
    const spotPrice = await scope.getPrice(token);
    const difference = spotPrice.price.sub(twapPrice.price);
    const diffPercent = difference.div(twapPrice.price).mul(100);

    console.log("\nSpot vs TWAP:");
    console.log("  Spot:", spotPrice.price.toFixed(6));
    console.log("  TWAP:", twapPrice.price.toFixed(6));
    console.log("  Difference:", diffPercent.toFixed(4), "%");
  } catch (error) {
    console.log("TWAP not available for", token);
  }
}
```

## Oracle Mapping

```typescript
async function exploreOracleMapping(): Promise<void> {
  console.log("\n=== Oracle Mapping ===\n");

  const mapping = await scope.getOracleMapping();

  console.log("Tokens mapped:", mapping.tokens.size);
  console.log("\nSupported tokens:\n");

  for (const [symbol, info] of mapping.tokens.entries()) {
    console.log(`${symbol}:`);
    console.log(`  Mint: ${info.mint.toString()}`);
    console.log(`  Oracle: ${info.oracleAddress.toString()}`);
    console.log(`  Type: ${info.oracleType}`);
    console.log(`  Decimals: ${info.decimals}`);
    console.log("");
  }
}
```

## Price Caching

```typescript
class ScopePriceCache {
  private cache: Map<string, { price: Decimal; timestamp: number }> = new Map();
  private maxAgeMs: number;
  private scope: Scope;

  constructor(scope: Scope, maxAgeMs: number = 5000) {
    this.scope = scope;
    this.maxAgeMs = maxAgeMs;
  }

  async getPrice(token: string): Promise<Decimal> {
    const now = Date.now();
    const cached = this.cache.get(token);

    if (cached && now - cached.timestamp < this.maxAgeMs) {
      return cached.price;
    }

    const priceData = await this.scope.getPrice(token);
    this.cache.set(token, { price: priceData.price, timestamp: now });

    return priceData.price;
  }

  async getPrices(tokens: string[]): Promise<Map<string, Decimal>> {
    const results = new Map<string, Decimal>();

    for (const token of tokens) {
      results.set(token, await this.getPrice(token));
    }

    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// Usage
// const priceCache = new ScopePriceCache(scope, 5000);
// const solPrice = await priceCache.getPrice("SOL");
```

## Integration with Kamino

```typescript
import { Kamino } from "@kamino-finance/kliquidity-sdk";

async function getStrategyValueWithOracle(
  kamino: Kamino,
  scope: Scope,
  strategyAddress: PublicKey
): Promise<Decimal> {
  // Get oracle prices for all tokens
  const oraclePrices = await scope.getOraclePrices();

  // Get share data using oracle prices
  const shareData = await kamino.getStrategyShareData(
    strategyAddress,
    oraclePrices
  );

  console.log("\n=== Strategy Value (Oracle-based) ===");
  console.log("Share Price:", shareData.sharePrice.toFixed(6));
  console.log("Total Shares:", shareData.totalShares.toString());
  console.log("TVL:", shareData.totalShares.mul(shareData.sharePrice).toFixed(2), "USD");

  return shareData.sharePrice;
}
```

## Full Example

```typescript
async function scopeOracleDemo(): Promise<void> {
  console.log("=== Scope Oracle Demo ===\n");

  // 1. Get all prices
  await getAllPrices();

  // 2. Get SOL price with validation
  const solPrice = await getValidatedPrice("SOL");

  // 3. Check price freshness
  await checkPriceFreshness("SOL", 100);

  // 4. Calculate portfolio value
  await calculatePortfolioValue([
    { symbol: "SOL", amount: new Decimal(2_000_000_000), decimals: 9 },
    { symbol: "USDC", amount: new Decimal(500_000_000), decimals: 6 },
  ]);

  // 5. Explore oracle sources
  await exploreOracleMapping();
}

scopeOracleDemo();
```

## Error Handling

```typescript
import { ScopeError } from "@kamino-finance/scope-sdk";

async function safePriceFetch(token: string): Promise<Decimal | null> {
  try {
    const price = await scope.getPrice(token);
    return price.price;
  } catch (error) {
    if (error instanceof ScopeError) {
      switch (error.code) {
        case "TOKEN_NOT_FOUND":
          console.error(`Token ${token} not supported by Scope`);
          break;
        case "STALE_PRICE":
          console.error(`Price for ${token} is stale`);
          break;
        case "ORACLE_ERROR":
          console.error(`Oracle error for ${token}:`, error.message);
          break;
        default:
          console.error(`Scope error:`, error.message);
      }
    } else {
      console.error("Unexpected error:", error);
    }
    return null;
  }
}
```
