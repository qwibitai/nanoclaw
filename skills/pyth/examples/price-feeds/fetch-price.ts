/**
 * Fetch Pyth Price - Basic Example
 *
 * Demonstrates fetching a single price from Pyth Network using the Hermes API.
 *
 * Setup:
 * npm install @pythnetwork/hermes-client
 *
 * Run:
 * npx ts-node fetch-price.ts
 */

import { HermesClient } from "@pythnetwork/hermes-client";

// Price Feed IDs (hex format with 0x prefix)
const PRICE_FEEDS = {
  BTC_USD: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH_USD: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL_USD: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

// Hermes endpoint (production)
const HERMES_ENDPOINT = "https://hermes.pyth.network";

/**
 * Convert Pyth price to human-readable format
 */
function formatPrice(price: string, expo: number): number {
  return Number(price) * Math.pow(10, expo);
}

/**
 * Format price with confidence interval
 */
function formatPriceWithConfidence(
  price: string,
  conf: string,
  expo: number
): { price: number; confidence: number; range: { low: number; high: number } } {
  const priceNum = formatPrice(price, expo);
  const confNum = formatPrice(conf, expo);

  return {
    price: priceNum,
    confidence: confNum,
    range: {
      low: priceNum - confNum,
      high: priceNum + confNum,
    },
  };
}

async function main() {
  console.log("=== Pyth Network Price Fetch Example ===\n");

  // Create Hermes client
  const client = new HermesClient(HERMES_ENDPOINT);

  // Fetch BTC/USD price
  console.log("Fetching BTC/USD price...\n");

  const updates = await client.getLatestPriceUpdates([PRICE_FEEDS.BTC_USD], {
    parsed: true,
  });

  // Process the price update
  for (const update of updates.parsed || []) {
    const { price, conf, expo, publish_time } = update.price;

    // Format the price
    const formatted = formatPriceWithConfidence(price, conf, expo);

    console.log("=== BTC/USD Price ===");
    console.log(`Feed ID: ${update.id}`);
    console.log(`Price: $${formatted.price.toLocaleString()}`);
    console.log(`Confidence: ±$${formatted.confidence.toLocaleString()}`);
    console.log(
      `Range: $${formatted.range.low.toLocaleString()} - $${formatted.range.high.toLocaleString()}`
    );
    console.log(`Published: ${new Date(publish_time * 1000).toISOString()}`);
    console.log(`Age: ${Math.floor(Date.now() / 1000) - publish_time}s ago`);

    // EMA price (exponential moving average)
    if (update.ema_price) {
      const ema = formatPriceWithConfidence(
        update.ema_price.price,
        update.ema_price.conf,
        update.ema_price.expo
      );
      console.log(`\nEMA Price: $${ema.price.toLocaleString()}`);
      console.log(`EMA Confidence: ±$${ema.confidence.toLocaleString()}`);
    }
  }

  // Show binary data for on-chain use
  console.log("\n=== Binary Data (for on-chain posting) ===");
  console.log(`Encoding: ${updates.binary.encoding}`);
  console.log(`Data length: ${updates.binary.data[0]?.length || 0} characters`);
  console.log(
    `Data preview: ${updates.binary.data[0]?.substring(0, 100)}...`
  );
}

main().catch(console.error);
