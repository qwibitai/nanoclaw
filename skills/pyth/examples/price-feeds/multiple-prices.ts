/**
 * Fetch Multiple Pyth Prices
 *
 * Demonstrates fetching multiple prices in a single request
 * and building a price dashboard.
 *
 * Setup:
 * npm install @pythnetwork/hermes-client
 *
 * Run:
 * npx ts-node multiple-prices.ts
 */

import { HermesClient } from "@pythnetwork/hermes-client";

// Comprehensive list of price feeds
const PRICE_FEEDS: Record<string, string> = {
  // Cryptocurrencies
  "BTC/USD": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "SOL/USD": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BNB/USD": "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
  "AVAX/USD": "0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",

  // Stablecoins
  "USDC/USD": "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDT/USD": "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",

  // Solana Ecosystem
  "JTO/USD": "0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  "JUP/USD": "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  "BONK/USD": "0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
};

const HERMES_ENDPOINT = "https://hermes.pyth.network";

interface PriceData {
  symbol: string;
  price: number;
  confidence: number;
  confidencePercent: number;
  publishTime: Date;
  age: number;
}

/**
 * Convert Pyth price to human-readable format
 */
function formatPrice(price: string, expo: number): number {
  return Number(price) * Math.pow(10, expo);
}

/**
 * Check if confidence is within acceptable range
 */
function isConfidenceAcceptable(
  price: number,
  confidence: number,
  maxPercent: number = 2
): boolean {
  const percent = (confidence / Math.abs(price)) * 100;
  return percent <= maxPercent;
}

async function fetchAllPrices(): Promise<Map<string, PriceData>> {
  const client = new HermesClient(HERMES_ENDPOINT);
  const priceMap = new Map<string, PriceData>();

  // Get all feed IDs
  const feedIds = Object.values(PRICE_FEEDS);
  const feedSymbols = Object.keys(PRICE_FEEDS);

  // Fetch all prices in a single request
  const updates = await client.getLatestPriceUpdates(feedIds, {
    parsed: true,
  });

  // Create a map of feed ID to symbol
  const idToSymbol = new Map<string, string>();
  for (const [symbol, id] of Object.entries(PRICE_FEEDS)) {
    // Remove 0x prefix for matching
    idToSymbol.set(id.slice(2).toLowerCase(), symbol);
  }

  // Process updates
  const now = Math.floor(Date.now() / 1000);

  for (const update of updates.parsed || []) {
    const symbol = idToSymbol.get(update.id.toLowerCase());
    if (!symbol) continue;

    const { price, conf, expo, publish_time } = update.price;
    const priceNum = formatPrice(price, expo);
    const confNum = formatPrice(conf, expo);

    priceMap.set(symbol, {
      symbol,
      price: priceNum,
      confidence: confNum,
      confidencePercent: (confNum / Math.abs(priceNum)) * 100,
      publishTime: new Date(publish_time * 1000),
      age: now - publish_time,
    });
  }

  return priceMap;
}

async function main() {
  console.log("=== Pyth Network Multi-Price Dashboard ===\n");

  const prices = await fetchAllPrices();

  // Display header
  console.log(
    "Symbol".padEnd(12) +
      "Price".padStart(15) +
      "Confidence".padStart(15) +
      "Conf %".padStart(10) +
      "Age".padStart(8)
  );
  console.log("-".repeat(60));

  // Display prices sorted by symbol
  const sortedPrices = Array.from(prices.values()).sort((a, b) =>
    a.symbol.localeCompare(b.symbol)
  );

  for (const data of sortedPrices) {
    const priceStr =
      data.price >= 1
        ? `$${data.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : `$${data.price.toFixed(8)}`;

    const confStr =
      data.confidence >= 0.01
        ? `±$${data.confidence.toFixed(2)}`
        : `±$${data.confidence.toFixed(8)}`;

    const confPercent = data.confidencePercent.toFixed(3) + "%";
    const ageStr = data.age + "s";

    // Color-code based on confidence (conceptual - actual coloring depends on terminal)
    const isHealthy = isConfidenceAcceptable(data.price, data.confidence);
    const status = isHealthy ? "✓" : "⚠";

    console.log(
      `${status} ${data.symbol.padEnd(10)}` +
        priceStr.padStart(15) +
        confStr.padStart(15) +
        confPercent.padStart(10) +
        ageStr.padStart(8)
    );
  }

  // Summary statistics
  console.log("\n=== Summary ===");
  console.log(`Total feeds: ${prices.size}`);

  const healthyCount = Array.from(prices.values()).filter((p) =>
    isConfidenceAcceptable(p.price, p.confidence)
  ).length;
  console.log(`Healthy (conf < 2%): ${healthyCount}/${prices.size}`);

  const avgAge =
    Array.from(prices.values()).reduce((sum, p) => sum + p.age, 0) /
    prices.size;
  console.log(`Average age: ${avgAge.toFixed(1)}s`);

  // Find stale prices
  const stalePrices = Array.from(prices.values()).filter((p) => p.age > 60);
  if (stalePrices.length > 0) {
    console.log(`\n⚠ Stale prices (>60s): ${stalePrices.map((p) => p.symbol).join(", ")}`);
  }
}

// Auto-refresh mode
async function dashboard(refreshInterval: number = 5000) {
  console.log("Starting dashboard with auto-refresh...\n");
  console.log("Press Ctrl+C to stop\n");

  while (true) {
    console.clear();
    await main();
    console.log(`\nRefreshing in ${refreshInterval / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, refreshInterval));
  }
}

// Run single fetch or dashboard
const args = process.argv.slice(2);
if (args.includes("--dashboard")) {
  dashboard().catch(console.error);
} else {
  main().catch(console.error);
}
