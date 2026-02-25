/**
 * DFlow Prediction Market - WebSocket Client Example
 *
 * Demonstrates how to connect to DFlow's WebSocket API for real-time data:
 * - Price updates
 * - Orderbook changes
 * - Trade notifications
 * - Multi-market subscriptions
 * - Reconnection handling
 */

import WebSocket from "ws";

// Configuration
const WS_URL = "wss://api.prod.dflow.net/ws";
const API_KEY = process.env.DFLOW_API_KEY || "";

// Types
interface PriceUpdate {
  type: "price_update";
  ticker: string;
  yes_price: number;
  no_price: number;
  timestamp: string;
}

interface OrderbookUpdate {
  type: "orderbook_update";
  ticker: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  spread: number;
  mid_price: number;
  timestamp: string;
}

interface TradeUpdate {
  type: "trade";
  ticker: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  timestamp: string;
}

interface SubscriptionMessage {
  action: "subscribe" | "unsubscribe";
  channel: "market" | "orderbook" | "trades";
  ticker: string;
}

interface ErrorMessage {
  type: "error";
  message: string;
  code?: string;
}

type WSMessage = PriceUpdate | OrderbookUpdate | TradeUpdate | ErrorMessage;

// ============================================
// WebSocket Client Class
// ============================================

class DFlowWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey: string;
  private subscriptions: Set<string> = new Set();
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000;
  private handlers: {
    price: ((update: PriceUpdate) => void)[];
    orderbook: ((update: OrderbookUpdate) => void)[];
    trade: ((update: TradeUpdate) => void)[];
    error: ((error: ErrorMessage) => void)[];
    connected: (() => void)[];
    disconnected: (() => void)[];
  } = {
    price: [],
    orderbook: [],
    trade: [],
    error: [],
    connected: [],
    disconnected: [],
  };

  constructor(url: string = WS_URL, apiKey: string = API_KEY) {
    this.url = url;
    this.apiKey = apiKey;
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Add API key as query parameter if available
        const wsUrl = this.apiKey
          ? `${this.url}?api_key=${this.apiKey}`
          : this.url;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          console.log("WebSocket connected");
          this.reconnectAttempts = 0;

          // Resubscribe to previous subscriptions
          this.resubscribe();

          // Notify handlers
          this.handlers.connected.forEach((h) => h());
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data.toString());
        };

        this.ws.onerror = (error) => {
          console.error("WebSocket error:", error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log("WebSocket disconnected");
          this.handlers.disconnected.forEach((h) => h());
          this.attemptReconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const message: WSMessage = JSON.parse(data);

      switch (message.type) {
        case "price_update":
          this.handlers.price.forEach((h) => h(message));
          break;
        case "orderbook_update":
          this.handlers.orderbook.forEach((h) => h(message));
          break;
        case "trade":
          this.handlers.trade.forEach((h) => h(message));
          break;
        case "error":
          this.handlers.error.forEach((h) => h(message));
          break;
        default:
          console.log("Unknown message type:", message);
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  }

  /**
   * Attempt to reconnect after disconnection
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((error) => {
        console.error("Reconnection failed:", error);
      });
    }, delay);
  }

  /**
   * Resubscribe to previous subscriptions after reconnect
   */
  private resubscribe(): void {
    for (const sub of this.subscriptions) {
      const [channel, ticker] = sub.split(":");
      this.send({
        action: "subscribe",
        channel: channel as "market" | "orderbook" | "trades",
        ticker,
      });
    }
  }

  /**
   * Send a message to the WebSocket server
   */
  private send(message: SubscriptionMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error("WebSocket is not connected");
    }
  }

  /**
   * Subscribe to price updates for a market
   */
  subscribePrice(ticker: string): void {
    const key = `market:${ticker}`;
    this.subscriptions.add(key);
    this.send({ action: "subscribe", channel: "market", ticker });
    console.log(`Subscribed to price updates for ${ticker}`);
  }

  /**
   * Subscribe to orderbook updates for a market
   */
  subscribeOrderbook(ticker: string): void {
    const key = `orderbook:${ticker}`;
    this.subscriptions.add(key);
    this.send({ action: "subscribe", channel: "orderbook", ticker });
    console.log(`Subscribed to orderbook updates for ${ticker}`);
  }

  /**
   * Subscribe to trade updates for a market
   */
  subscribeTrades(ticker: string): void {
    const key = `trades:${ticker}`;
    this.subscriptions.add(key);
    this.send({ action: "subscribe", channel: "trades", ticker });
    console.log(`Subscribed to trade updates for ${ticker}`);
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel: "market" | "orderbook" | "trades", ticker: string): void {
    const key = `${channel}:${ticker}`;
    this.subscriptions.delete(key);
    this.send({ action: "unsubscribe", channel, ticker });
    console.log(`Unsubscribed from ${channel} updates for ${ticker}`);
  }

  /**
   * Register event handlers
   */
  onPrice(handler: (update: PriceUpdate) => void): void {
    this.handlers.price.push(handler);
  }

  onOrderbook(handler: (update: OrderbookUpdate) => void): void {
    this.handlers.orderbook.push(handler);
  }

  onTrade(handler: (update: TradeUpdate) => void): void {
    this.handlers.trade.push(handler);
  }

  onError(handler: (error: ErrorMessage) => void): void {
    this.handlers.error.push(handler);
  }

  onConnected(handler: () => void): void {
    this.handlers.connected.push(handler);
  }

  onDisconnected(handler: () => void): void {
    this.handlers.disconnected.push(handler);
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions.clear();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// ============================================
// Price Tracker Example
// ============================================

class PriceTracker {
  private prices: Map<string, { yes: number; no: number; timestamp: string }> =
    new Map();

  update(ticker: string, yesPrice: number, noPrice: number, timestamp: string): void {
    this.prices.set(ticker, { yes: yesPrice, no: noPrice, timestamp });
  }

  get(ticker: string): { yes: number; no: number; timestamp: string } | undefined {
    return this.prices.get(ticker);
  }

  getAll(): Map<string, { yes: number; no: number; timestamp: string }> {
    return this.prices;
  }

  printSummary(): void {
    console.log("\n--- Price Summary ---");
    for (const [ticker, price] of this.prices) {
      console.log(
        `${ticker}: YES=${price.yes.toFixed(4)}, NO=${price.no.toFixed(4)}`
      );
    }
    console.log("-------------------\n");
  }
}

// ============================================
// Orderbook Aggregator Example
// ============================================

class OrderbookAggregator {
  private orderbooks: Map<
    string,
    {
      bids: Array<{ price: number; quantity: number }>;
      asks: Array<{ price: number; quantity: number }>;
      spread: number;
      midPrice: number;
    }
  > = new Map();

  update(ticker: string, update: OrderbookUpdate): void {
    this.orderbooks.set(ticker, {
      bids: update.bids,
      asks: update.asks,
      spread: update.spread,
      midPrice: update.mid_price,
    });
  }

  getBestBid(ticker: string): { price: number; quantity: number } | undefined {
    const ob = this.orderbooks.get(ticker);
    return ob?.bids[0];
  }

  getBestAsk(ticker: string): { price: number; quantity: number } | undefined {
    const ob = this.orderbooks.get(ticker);
    return ob?.asks[0];
  }

  getSpread(ticker: string): number | undefined {
    return this.orderbooks.get(ticker)?.spread;
  }

  printSummary(ticker: string): void {
    const ob = this.orderbooks.get(ticker);
    if (!ob) {
      console.log(`No orderbook data for ${ticker}`);
      return;
    }

    console.log(`\n--- Orderbook: ${ticker} ---`);
    console.log(`Mid price: ${ob.midPrice.toFixed(4)}`);
    console.log(`Spread: ${ob.spread.toFixed(4)}`);
    console.log("Top 3 bids:");
    ob.bids.slice(0, 3).forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.price.toFixed(4)} x ${b.quantity}`);
    });
    console.log("Top 3 asks:");
    ob.asks.slice(0, 3).forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.price.toFixed(4)} x ${a.quantity}`);
    });
    console.log("--------------------------\n");
  }
}

// ============================================
// Trade Monitor Example
// ============================================

class TradeMonitor {
  private recentTrades: TradeUpdate[] = [];
  private maxTrades: number = 100;
  private volumeByTicker: Map<string, number> = new Map();

  addTrade(trade: TradeUpdate): void {
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > this.maxTrades) {
      this.recentTrades.pop();
    }

    // Update volume
    const currentVolume = this.volumeByTicker.get(trade.ticker) || 0;
    this.volumeByTicker.set(trade.ticker, currentVolume + trade.quantity);
  }

  getRecentTrades(ticker?: string, limit: number = 10): TradeUpdate[] {
    const trades = ticker
      ? this.recentTrades.filter((t) => t.ticker === ticker)
      : this.recentTrades;
    return trades.slice(0, limit);
  }

  getVolume(ticker: string): number {
    return this.volumeByTicker.get(ticker) || 0;
  }

  printRecentTrades(ticker?: string): void {
    const trades = this.getRecentTrades(ticker, 5);
    console.log(`\n--- Recent Trades ${ticker ? `(${ticker})` : ""} ---`);
    for (const trade of trades) {
      const side = trade.side === "buy" ? "BUY " : "SELL";
      console.log(
        `  ${side} ${trade.quantity} @ ${trade.price.toFixed(4)} (${trade.outcome})`
      );
    }
    console.log("---------------------------\n");
  }
}

// ============================================
// Example Usage
// ============================================

async function main() {
  console.log("DFlow Prediction Market - WebSocket Client Example\n");
  console.log("=".repeat(50));

  // Create client and helpers
  const client = new DFlowWebSocketClient();
  const priceTracker = new PriceTracker();
  const orderbookAgg = new OrderbookAggregator();
  const tradeMonitor = new TradeMonitor();

  // Set up event handlers
  client.onPrice((update) => {
    console.log(
      `[PRICE] ${update.ticker}: YES=${update.yes_price.toFixed(4)}, NO=${update.no_price.toFixed(4)}`
    );
    priceTracker.update(
      update.ticker,
      update.yes_price,
      update.no_price,
      update.timestamp
    );
  });

  client.onOrderbook((update) => {
    console.log(
      `[ORDERBOOK] ${update.ticker}: spread=${update.spread.toFixed(4)}, mid=${update.mid_price.toFixed(4)}`
    );
    orderbookAgg.update(update.ticker, update);
  });

  client.onTrade((update) => {
    const side = update.side === "buy" ? "BUY " : "SELL";
    console.log(
      `[TRADE] ${update.ticker}: ${side} ${update.quantity} @ ${update.price.toFixed(4)} (${update.outcome})`
    );
    tradeMonitor.addTrade(update);
  });

  client.onError((error) => {
    console.error(`[ERROR] ${error.message}`);
  });

  client.onConnected(() => {
    console.log("[STATUS] Connected to DFlow WebSocket");
  });

  client.onDisconnected(() => {
    console.log("[STATUS] Disconnected from DFlow WebSocket");
  });

  try {
    // Connect
    console.log("\nConnecting to WebSocket...");
    await client.connect();

    // Subscribe to markets
    const markets = ["TRUMP-2024-WIN", "BTC-100K-2024"];
    console.log(`\nSubscribing to markets: ${markets.join(", ")}`);

    for (const market of markets) {
      client.subscribePrice(market);
      client.subscribeOrderbook(market);
      client.subscribeTrades(market);
    }

    // Let it run for a while
    console.log("\nListening for updates (press Ctrl+C to stop)...\n");

    // Print summaries periodically
    const summaryInterval = setInterval(() => {
      priceTracker.printSummary();
      for (const market of markets) {
        orderbookAgg.printSummary(market);
      }
      tradeMonitor.printRecentTrades();
    }, 30000); // Every 30 seconds

    // Handle shutdown
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      clearInterval(summaryInterval);
      client.close();
      process.exit(0);
    });

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    console.error("Failed to connect:", error);
    process.exit(1);
  }
}

// Simple example without classes
async function simpleExample() {
  console.log("Simple WebSocket Example\n");

  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected!");

    // Subscribe to a market
    ws.send(
      JSON.stringify({
        action: "subscribe",
        channel: "market",
        ticker: "SAMPLE-MARKET",
      })
    );
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data.toString());
    console.log("Received:", data);
  };

  ws.onerror = (error) => {
    console.error("Error:", error);
  };

  ws.onclose = () => {
    console.log("Disconnected");
  };
}

// Run main example
main();

// Export for use in other modules
export {
  DFlowWebSocketClient,
  PriceTracker,
  OrderbookAggregator,
  TradeMonitor,
  simpleExample,
};
