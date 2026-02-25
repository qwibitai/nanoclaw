/**
 * Switchboard Surge Real-Time Streaming Example
 *
 * This example demonstrates how to use Switchboard Surge
 * for real-time price streaming via WebSocket.
 */

import { SwitchboardSurge } from "@switchboard-xyz/on-demand";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Surge WebSocket endpoint
  gatewayUrl:
    process.env.SURGE_GATEWAY || "wss://surge.switchboard.xyz",

  // Optional API key for higher rate limits
  apiKey: process.env.SWITCHBOARD_API_KEY || undefined,

  // Reconnection settings
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000, // ms

  // Feeds to subscribe to
  feeds: process.env.SURGE_FEEDS?.split(",") || [
    "SOL/USD",
    "BTC/USD",
    "ETH/USD",
  ],

  // Duration to run (ms), 0 for indefinite
  duration: parseInt(process.env.DURATION || "30000"),
};

// ============================================================================
// TYPES
// ============================================================================

interface PriceData {
  symbol: string;
  price: number;
  timestamp: number;
  confidence?: number;
}

interface PriceHistory {
  prices: PriceData[];
  min: number;
  max: number;
  avg: number;
}

// ============================================================================
// PRICE TRACKING
// ============================================================================

class PriceTracker {
  private history: Map<string, PriceData[]> = new Map();
  private maxHistory: number = 100;

  /**
   * Add price update
   */
  addPrice(data: PriceData): void {
    if (!this.history.has(data.symbol)) {
      this.history.set(data.symbol, []);
    }

    const prices = this.history.get(data.symbol)!;
    prices.push(data);

    // Trim history if needed
    if (prices.length > this.maxHistory) {
      prices.shift();
    }
  }

  /**
   * Get price statistics for a symbol
   */
  getStats(symbol: string): PriceHistory | null {
    const prices = this.history.get(symbol);
    if (!prices || prices.length === 0) return null;

    const values = prices.map((p) => p.price);
    return {
      prices,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }

  /**
   * Get latest price for a symbol
   */
  getLatest(symbol: string): PriceData | null {
    const prices = this.history.get(symbol);
    if (!prices || prices.length === 0) return null;
    return prices[prices.length - 1];
  }

  /**
   * Get all tracked symbols
   */
  getSymbols(): string[] {
    return Array.from(this.history.keys());
  }
}

// ============================================================================
// SURGE STREAMING
// ============================================================================

/**
 * Create and configure Surge client
 */
function createSurgeClient(): SwitchboardSurge {
  return new SwitchboardSurge({
    apiKey: CONFIG.apiKey,
    gatewayUrl: CONFIG.gatewayUrl,
    autoReconnect: CONFIG.autoReconnect,
    maxReconnectAttempts: CONFIG.maxReconnectAttempts,
    reconnectDelay: CONFIG.reconnectDelay,
  });
}

/**
 * Format price for display
 */
function formatPrice(price: number, symbol: string): string {
  // Use appropriate decimal places based on asset
  const decimals = symbol.includes("BTC") ? 2 : symbol.includes("ETH") ? 2 : 4;
  return price.toFixed(decimals);
}

/**
 * Format timestamp
 */
function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Surge Real-Time Streaming");
  console.log("=".repeat(60));

  console.log("\nConfiguration:");
  console.log("  Gateway:", CONFIG.gatewayUrl);
  console.log("  Feeds:", CONFIG.feeds.join(", "));
  console.log("  API Key:", CONFIG.apiKey ? "***" : "Not set");
  console.log("  Duration:", CONFIG.duration > 0 ? `${CONFIG.duration}ms` : "Indefinite");

  // Create tracker
  const tracker = new PriceTracker();

  // Create Surge client
  const surge = createSurgeClient();

  // Track connection state
  let isConnected = false;
  let updateCount = 0;

  // Setup event handlers
  surge.on("connected", () => {
    isConnected = true;
    console.log("\n✅ Connected to Switchboard Surge");
    console.log("Subscribing to feeds...\n");
  });

  surge.on("data", (data: PriceData) => {
    updateCount++;

    // Track price
    tracker.addPrice(data);

    // Display update
    const priceStr = formatPrice(data.price, data.symbol);
    const timeStr = formatTimestamp(data.timestamp);
    const confStr = data.confidence ? ` ±${data.confidence.toFixed(4)}` : "";

    console.log(`[${timeStr}] ${data.symbol}: $${priceStr}${confStr}`);
  });

  surge.on("error", (error: Error) => {
    console.error("\n❌ Surge error:", error.message);
  });

  surge.on("disconnected", () => {
    isConnected = false;
    console.log("\n⚠️ Disconnected from Switchboard Surge");
  });

  // Subscribe to feeds
  console.log("\nConnecting to Switchboard Surge...");
  surge.subscribe(CONFIG.feeds);

  // Run for specified duration
  if (CONFIG.duration > 0) {
    await new Promise((resolve) => setTimeout(resolve, CONFIG.duration));

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("Session Summary");
    console.log("=".repeat(60));
    console.log(`Total updates: ${updateCount}`);

    for (const symbol of tracker.getSymbols()) {
      const stats = tracker.getStats(symbol);
      if (stats) {
        console.log(`\n${symbol}:`);
        console.log(`  Updates: ${stats.prices.length}`);
        console.log(`  Min: $${formatPrice(stats.min, symbol)}`);
        console.log(`  Max: $${formatPrice(stats.max, symbol)}`);
        console.log(`  Avg: $${formatPrice(stats.avg, symbol)}`);
      }
    }

    // Cleanup
    console.log("\nDisconnecting...");
    // surge.close(); // If available
    process.exit(0);
  } else {
    // Run indefinitely
    console.log("\nStreaming indefinitely. Press Ctrl+C to stop.\n");

    process.on("SIGINT", () => {
      console.log("\n\nStopping...");
      console.log(`Total updates received: ${updateCount}`);
      process.exit(0);
    });
  }
}

// ============================================================================
// ALTERNATIVE: SIMPLE STREAMING EXAMPLE
// ============================================================================

async function simpleExample() {
  console.log("Simple Surge Streaming Example\n");

  const surge = new SwitchboardSurge({
    gatewayUrl: "wss://surge.switchboard.xyz",
    autoReconnect: true,
  });

  surge.on("connected", () => console.log("Connected!"));
  surge.on("data", (data) => console.log(`${data.symbol}: $${data.price}`));
  surge.on("error", (err) => console.error("Error:", err));

  surge.subscribe(["SOL/USD", "BTC/USD"]);

  // Keep alive
  await new Promise(() => {});
}

// ============================================================================
// RUN
// ============================================================================

// Run main example by default
main().catch(console.error);

// Export for use in other files
export { createSurgeClient, PriceTracker, CONFIG };
