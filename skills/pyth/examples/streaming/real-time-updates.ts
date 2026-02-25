/**
 * Real-Time Pyth Price Streaming
 *
 * Demonstrates subscribing to real-time price updates via Server-Sent Events.
 *
 * Setup:
 * npm install @pythnetwork/hermes-client
 *
 * Run:
 * npx ts-node real-time-updates.ts
 */

import { HermesClient } from "@pythnetwork/hermes-client";

// Price Feed IDs to monitor
const PRICE_FEEDS = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

const HERMES_ENDPOINT = "https://hermes.pyth.network";

// Statistics tracking
interface PriceStats {
  symbol: string;
  lastPrice: number;
  lastUpdate: Date;
  updateCount: number;
  minPrice: number;
  maxPrice: number;
  priceHistory: { price: number; time: Date }[];
}

const stats: Map<string, PriceStats> = new Map();

/**
 * Format Pyth price
 */
function formatPrice(price: string, expo: number): number {
  return Number(price) * Math.pow(10, expo);
}

/**
 * Get symbol from feed ID
 */
function getSymbol(feedId: string): string {
  const cleanId = feedId.toLowerCase().replace("0x", "");
  for (const [symbol, id] of Object.entries(PRICE_FEEDS)) {
    if (id.toLowerCase().replace("0x", "") === cleanId) {
      return symbol;
    }
  }
  return feedId.slice(0, 8) + "...";
}

/**
 * Initialize stats for a symbol
 */
function initStats(symbol: string, price: number): PriceStats {
  return {
    symbol,
    lastPrice: price,
    lastUpdate: new Date(),
    updateCount: 1,
    minPrice: price,
    maxPrice: price,
    priceHistory: [{ price, time: new Date() }],
  };
}

/**
 * Update stats with new price
 */
function updateStats(symbol: string, price: number): void {
  const existing = stats.get(symbol);
  if (!existing) {
    stats.set(symbol, initStats(symbol, price));
    return;
  }

  existing.lastPrice = price;
  existing.lastUpdate = new Date();
  existing.updateCount++;
  existing.minPrice = Math.min(existing.minPrice, price);
  existing.maxPrice = Math.max(existing.maxPrice, price);

  // Keep last 100 prices for history
  existing.priceHistory.push({ price, time: new Date() });
  if (existing.priceHistory.length > 100) {
    existing.priceHistory.shift();
  }
}

/**
 * Calculate price change percentage
 */
function getPriceChange(symbol: string): { change: number; percent: number } | null {
  const stat = stats.get(symbol);
  if (!stat || stat.priceHistory.length < 2) {
    return null;
  }

  const firstPrice = stat.priceHistory[0].price;
  const change = stat.lastPrice - firstPrice;
  const percent = (change / firstPrice) * 100;

  return { change, percent };
}

/**
 * Display current status
 */
function displayStatus(): void {
  console.clear();
  console.log("=== Pyth Real-Time Price Feed ===");
  console.log(`Time: ${new Date().toISOString()}\n`);

  console.log(
    "Symbol".padEnd(8) +
      "Price".padStart(15) +
      "Change".padStart(12) +
      "Min".padStart(15) +
      "Max".padStart(15) +
      "Updates".padStart(10)
  );
  console.log("-".repeat(75));

  for (const [symbol, stat] of stats) {
    const priceStr = `$${stat.lastPrice.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;

    const changeData = getPriceChange(symbol);
    let changeStr = "N/A";
    if (changeData) {
      const sign = changeData.percent >= 0 ? "+" : "";
      changeStr = `${sign}${changeData.percent.toFixed(2)}%`;
    }

    const minStr = `$${stat.minPrice.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
    const maxStr = `$${stat.maxPrice.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;

    console.log(
      symbol.padEnd(8) +
        priceStr.padStart(15) +
        changeStr.padStart(12) +
        minStr.padStart(15) +
        maxStr.padStart(15) +
        stat.updateCount.toString().padStart(10)
    );
  }

  console.log("\nPress Ctrl+C to stop");
}

/**
 * Price update callback
 */
function handlePriceUpdate(data: any): void {
  if (!data.parsed) return;

  for (const update of data.parsed) {
    const symbol = getSymbol(update.id);
    const price = formatPrice(update.price.price, update.price.expo);
    updateStats(symbol, price);
  }
}

/**
 * Main streaming function
 */
async function streamPrices(): Promise<void> {
  console.log("Connecting to Pyth Hermes...\n");

  const client = new HermesClient(HERMES_ENDPOINT);
  const feedIds = Object.values(PRICE_FEEDS);

  // Start the price stream
  const eventSource = await client.getPriceUpdatesStream(feedIds, {
    parsed: true,
    allowUnordered: false,
  });

  console.log("Connected! Streaming prices...\n");

  // Handle incoming messages
  eventSource.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      handlePriceUpdate(data);
    } catch (error) {
      console.error("Error parsing event:", error);
    }
  };

  // Handle errors
  eventSource.onerror = (error: Event) => {
    console.error("Stream error:", error);
    console.log("Attempting to reconnect...");
  };

  // Update display periodically
  const displayInterval = setInterval(displayStatus, 500);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\nShutting down...");
    clearInterval(displayInterval);
    eventSource.close();
    printSummary();
    process.exit(0);
  });
}

/**
 * Print final summary
 */
function printSummary(): void {
  console.log("\n=== Session Summary ===\n");

  for (const [symbol, stat] of stats) {
    const sessionStart = stat.priceHistory[0];
    const sessionEnd = stat.priceHistory[stat.priceHistory.length - 1];
    const duration = (sessionEnd.time.getTime() - sessionStart.time.getTime()) / 1000;
    const updatesPerSecond = stat.updateCount / duration;

    console.log(`${symbol}:`);
    console.log(`  Total updates: ${stat.updateCount}`);
    console.log(`  Updates/second: ${updatesPerSecond.toFixed(2)}`);
    console.log(
      `  Price range: $${stat.minPrice.toLocaleString()} - $${stat.maxPrice.toLocaleString()}`
    );
    console.log(
      `  Range %: ${(((stat.maxPrice - stat.minPrice) / stat.minPrice) * 100).toFixed(3)}%`
    );
    console.log();
  }
}

/**
 * Alternative: Polling approach (for environments without SSE support)
 */
async function pollPrices(intervalMs: number = 1000): Promise<void> {
  console.log("Starting polling mode...\n");

  const client = new HermesClient(HERMES_ENDPOINT);
  const feedIds = Object.values(PRICE_FEEDS);

  const poll = async () => {
    try {
      const updates = await client.getLatestPriceUpdates(feedIds, {
        parsed: true,
      });

      for (const update of updates.parsed || []) {
        const symbol = getSymbol(update.id);
        const price = formatPrice(update.price.price, update.price.expo);
        updateStats(symbol, price);
      }
    } catch (error) {
      console.error("Poll error:", error);
    }
  };

  // Initial fetch
  await poll();

  // Start polling
  const pollInterval = setInterval(poll, intervalMs);
  const displayInterval = setInterval(displayStatus, 500);

  process.on("SIGINT", () => {
    console.log("\n\nShutting down...");
    clearInterval(pollInterval);
    clearInterval(displayInterval);
    printSummary();
    process.exit(0);
  });
}

/**
 * Price alert system
 */
interface PriceAlert {
  symbol: string;
  condition: "above" | "below";
  threshold: number;
  triggered: boolean;
  callback: (price: number) => void;
}

class PriceAlertMonitor {
  private alerts: PriceAlert[] = [];
  private client: HermesClient;
  private eventSource: EventSource | null = null;

  constructor(endpoint: string = HERMES_ENDPOINT) {
    this.client = new HermesClient(endpoint);
  }

  addAlert(
    symbol: string,
    condition: "above" | "below",
    threshold: number,
    callback: (price: number) => void
  ): void {
    this.alerts.push({
      symbol,
      condition,
      threshold,
      triggered: false,
      callback,
    });
  }

  private checkAlerts(symbol: string, price: number): void {
    for (const alert of this.alerts) {
      if (alert.symbol !== symbol || alert.triggered) continue;

      const shouldTrigger =
        (alert.condition === "above" && price >= alert.threshold) ||
        (alert.condition === "below" && price <= alert.threshold);

      if (shouldTrigger) {
        alert.triggered = true;
        alert.callback(price);
      }
    }
  }

  async start(feedIds: string[]): Promise<void> {
    this.eventSource = await this.client.getPriceUpdatesStream(feedIds, {
      parsed: true,
    });

    this.eventSource.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      for (const update of data.parsed || []) {
        const symbol = getSymbol(update.id);
        const price = formatPrice(update.price.price, update.price.expo);
        this.checkAlerts(symbol, price);
      }
    };
  }

  stop(): void {
    this.eventSource?.close();
  }
}

// Example usage of alert system
async function alertExample(): Promise<void> {
  const monitor = new PriceAlertMonitor();

  // Set up alerts
  monitor.addAlert("BTC", "above", 100000, (price) => {
    console.log(`🚨 ALERT: BTC crossed $100,000! Current: $${price.toLocaleString()}`);
  });

  monitor.addAlert("ETH", "below", 2000, (price) => {
    console.log(`🚨 ALERT: ETH dropped below $2,000! Current: $${price.toLocaleString()}`);
  });

  console.log("Starting price alert monitor...");
  await monitor.start(Object.values(PRICE_FEEDS));

  // Run for 1 hour then stop
  setTimeout(() => {
    monitor.stop();
    console.log("Alert monitoring stopped");
  }, 3600000);
}

// Run based on command line args
const args = process.argv.slice(2);
if (args.includes("--poll")) {
  const interval = parseInt(args[args.indexOf("--poll") + 1]) || 1000;
  pollPrices(interval).catch(console.error);
} else if (args.includes("--alerts")) {
  alertExample().catch(console.error);
} else {
  streamPrices().catch(console.error);
}
