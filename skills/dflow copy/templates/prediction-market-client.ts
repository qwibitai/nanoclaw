/**
 * DFlow Prediction Market Client - Copy-Paste Template
 *
 * A production-ready client for interacting with DFlow's Prediction Market APIs.
 * Copy this file to your project and customize as needed.
 *
 * Features:
 * - Metadata API (events, markets, orderbooks, trades)
 * - Swap API (trading outcome tokens)
 * - WebSocket (real-time updates)
 * - Full TypeScript types
 * - Error handling
 * - Rate limiting
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import WebSocket from "ws";

// ============================================
// Configuration
// ============================================

const CONFIG = {
  SWAP_API: "https://quote-api.dflow.net",
  METADATA_API: "https://api.prod.dflow.net",
  WS_URL: "wss://api.prod.dflow.net/ws",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ============================================
// Types
// ============================================

// Events
export interface Event {
  ticker: string;
  title: string;
  description: string;
  status: "active" | "closed" | "determined" | "finalized";
  series_ticker: string;
  category: string;
  close_time: string;
  markets?: Market[];
}

// Markets
export interface Market {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_mint: string;
  no_mint: string;
  ledger_mint: string;
  status: string;
  last_price: number;
  yes_price: number;
  no_price: number;
  volume_24h: number;
  open_interest: number;
}

// Orderbook
export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface Orderbook {
  ticker: string;
  timestamp: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  mid_price: number;
}

// Trades
export interface Trade {
  id: string;
  ticker: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  timestamp: string;
}

// Orders
export interface OrderResponse {
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  executionMode: "sync" | "async";
  transaction: string;
  computeUnitLimit: number;
  lastValidBlockHeight: number;
  routePlan: Array<{
    venue: string;
    inAmount: string;
    outAmount: string;
  }>;
}

export interface OrderStatus {
  status: "pending" | "open" | "pendingClose" | "closed" | "expired" | "failed";
  inAmount?: string;
  outAmount?: string;
  fills?: Array<{
    signature: string;
    inAmount: string;
    outAmount: string;
    timestamp: number;
  }>;
}

// WebSocket
export interface PriceUpdate {
  type: "price_update";
  ticker: string;
  yes_price: number;
  no_price: number;
  timestamp: string;
}

export interface OrderbookUpdate {
  type: "orderbook_update";
  ticker: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  mid_price: number;
  timestamp: string;
}

export interface TradeUpdate {
  type: "trade";
  ticker: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  timestamp: string;
}

// Pagination
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================
// DFlow Prediction Market Client
// ============================================

export class DFlowPredictionMarketClient {
  private apiKey: string;
  private connection: Connection;
  private keypair?: Keypair;
  private ws?: WebSocket;

  constructor(options: {
    apiKey?: string;
    rpcUrl: string;
    privateKey?: string;
  }) {
    this.apiKey = options.apiKey || "";
    this.connection = new Connection(options.rpcUrl, "confirmed");

    if (options.privateKey) {
      // Support base58 or Uint8Array
      if (typeof options.privateKey === "string") {
        const bs58 = require("bs58");
        this.keypair = Keypair.fromSecretKey(bs58.decode(options.privateKey));
      }
    }
  }

  // ----------------------------------------
  // HTTP Helpers
  // ----------------------------------------

  private async metadataRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const response = await fetch(`${CONFIG.METADATA_API}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Metadata API Error ${response.status}: ${error}`);
    }

    return response.json();
  }

  private async swapRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    const response = await fetch(`${CONFIG.SWAP_API}${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Swap API Error ${response.status}: ${error}`);
    }

    return response.json();
  }

  // ----------------------------------------
  // Events API
  // ----------------------------------------

  async getEvent(ticker: string, includeMarkets = true): Promise<Event> {
    const params = includeMarkets ? "?include_markets=true" : "";
    return this.metadataRequest<Event>(`/api/v1/event/${ticker}${params}`);
  }

  async getEvents(options: {
    limit?: number;
    offset?: number;
    status?: string;
    category?: string;
  } = {}): Promise<{ events: Event[]; total: number }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", options.limit.toString());
    if (options.offset) params.set("offset", options.offset.toString());
    if (options.status) params.set("status", options.status);
    if (options.category) params.set("category", options.category);

    return this.metadataRequest(`/api/v1/events?${params}`);
  }

  async searchEvents(query: string): Promise<{
    results: Array<{
      type: "event" | "market";
      ticker: string;
      title: string;
    }>;
  }> {
    return this.metadataRequest(`/api/v1/search?q=${encodeURIComponent(query)}`);
  }

  // ----------------------------------------
  // Markets API
  // ----------------------------------------

  async getMarket(ticker: string): Promise<Market> {
    return this.metadataRequest<Market>(`/api/v1/market/${ticker}`);
  }

  async getMarketByMint(mintAddress: string): Promise<Market> {
    return this.metadataRequest<Market>(`/api/v1/market/by-mint/${mintAddress}`);
  }

  async getMarketsBatch(
    tickers: string[],
    mints: string[] = []
  ): Promise<{ markets: Market[]; not_found: string[] }> {
    return this.metadataRequest(`/api/v1/markets/batch`, {
      method: "POST",
      body: JSON.stringify({ tickers, mints }),
    });
  }

  async getOutcomeMints(minCloseTimestamp?: number): Promise<{
    outcome_mints: Array<{
      mint: string;
      market_ticker: string;
      outcome: "yes" | "no";
    }>;
  }> {
    const params = minCloseTimestamp
      ? `?min_close_timestamp=${minCloseTimestamp}`
      : "";
    return this.metadataRequest(`/api/v1/outcome_mints${params}`);
  }

  async filterOutcomeMints(addresses: string[]): Promise<{
    outcome_mints: Array<{
      mint: string;
      market_ticker: string;
      outcome: "yes" | "no";
    }>;
    non_outcome_mints: string[];
  }> {
    return this.metadataRequest(`/api/v1/filter_outcome_mints`, {
      method: "POST",
      body: JSON.stringify({ addresses }),
    });
  }

  // ----------------------------------------
  // Orderbook API
  // ----------------------------------------

  async getOrderbook(ticker: string, depth = 10): Promise<Orderbook> {
    return this.metadataRequest<Orderbook>(
      `/api/v1/orderbook/${ticker}?depth=${depth}`
    );
  }

  async getOrderbookByMint(mintAddress: string, depth = 10): Promise<Orderbook> {
    return this.metadataRequest<Orderbook>(
      `/api/v1/orderbook/by-mint/${mintAddress}?depth=${depth}`
    );
  }

  // ----------------------------------------
  // Trades API
  // ----------------------------------------

  async getTrades(options: {
    ticker?: string;
    limit?: number;
    offset?: number;
    startTime?: number;
    endTime?: number;
  } = {}): Promise<{ trades: Trade[]; total: number }> {
    const params = new URLSearchParams();
    if (options.ticker) params.set("ticker", options.ticker);
    if (options.limit) params.set("limit", options.limit.toString());
    if (options.offset) params.set("offset", options.offset.toString());
    if (options.startTime) params.set("start_time", options.startTime.toString());
    if (options.endTime) params.set("end_time", options.endTime.toString());

    return this.metadataRequest(`/api/v1/trades?${params}`);
  }

  // ----------------------------------------
  // Categories & Series
  // ----------------------------------------

  async getCategories(): Promise<{
    categories: Array<{ id: string; name: string; events_count: number }>;
  }> {
    return this.metadataRequest(`/api/v1/categories`);
  }

  async getSeries(category?: string): Promise<{
    series: Array<{
      ticker: string;
      title: string;
      category: string;
      events_count: number;
    }>;
  }> {
    const params = category ? `?category=${category}` : "";
    return this.metadataRequest(`/api/v1/series${params}`);
  }

  // ----------------------------------------
  // Trading API
  // ----------------------------------------

  async getOrder(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    userPublicKey?: string;
    slippageBps?: string;
    predictionMarketSlippageBps?: string;
  }): Promise<OrderResponse> {
    const searchParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: params.slippageBps || "100",
    });

    if (params.userPublicKey) {
      searchParams.set("userPublicKey", params.userPublicKey);
    }
    if (params.predictionMarketSlippageBps) {
      searchParams.set(
        "predictionMarketSlippageBps",
        params.predictionMarketSlippageBps
      );
    }

    return this.swapRequest<OrderResponse>(`/order?${searchParams}`);
  }

  async getOrderStatus(
    signature: string,
    lastValidBlockHeight?: number
  ): Promise<OrderStatus> {
    const params = new URLSearchParams({ signature });
    if (lastValidBlockHeight) {
      params.set("lastValidBlockHeight", lastValidBlockHeight.toString());
    }
    return this.swapRequest<OrderStatus>(`/order-status?${params}`);
  }

  async buyOutcome(
    market: Market,
    outcome: "yes" | "no",
    usdcAmount: string
  ): Promise<{ signature: string; outAmount: string }> {
    if (!this.keypair) {
      throw new Error("Keypair required for trading");
    }

    const outputMint = outcome === "yes" ? market.yes_mint : market.no_mint;

    const order = await this.getOrder({
      inputMint: CONFIG.USDC_MINT,
      outputMint,
      amount: usdcAmount,
      userPublicKey: this.keypair.publicKey.toBase58(),
      slippageBps: "100",
      predictionMarketSlippageBps: "200",
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(order.transaction, "base64")
    );
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx);

    if (order.executionMode === "async") {
      const finalStatus = await this.monitorOrder(
        signature,
        order.lastValidBlockHeight
      );
      return {
        signature,
        outAmount: finalStatus.outAmount || order.outAmount,
      };
    } else {
      await this.connection.confirmTransaction(signature, "confirmed");
      return { signature, outAmount: order.outAmount };
    }
  }

  async sellOutcome(
    market: Market,
    outcome: "yes" | "no",
    amount: string
  ): Promise<{ signature: string; outAmount: string }> {
    if (!this.keypair) {
      throw new Error("Keypair required for trading");
    }

    const inputMint = outcome === "yes" ? market.yes_mint : market.no_mint;

    const order = await this.getOrder({
      inputMint,
      outputMint: CONFIG.USDC_MINT,
      amount,
      userPublicKey: this.keypair.publicKey.toBase58(),
    });

    const tx = VersionedTransaction.deserialize(
      Buffer.from(order.transaction, "base64")
    );
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx);

    if (order.executionMode === "async") {
      const finalStatus = await this.monitorOrder(
        signature,
        order.lastValidBlockHeight
      );
      return {
        signature,
        outAmount: finalStatus.outAmount || order.outAmount,
      };
    } else {
      await this.connection.confirmTransaction(signature, "confirmed");
      return { signature, outAmount: order.outAmount };
    }
  }

  private async monitorOrder(
    signature: string,
    lastValidBlockHeight: number,
    timeoutMs = 60000
  ): Promise<OrderStatus> {
    const startTime = Date.now();
    const pendingStatuses = ["pending", "open", "pendingClose"];

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getOrderStatus(signature, lastValidBlockHeight);

      if (!pendingStatuses.includes(status.status)) {
        if (status.status === "failed" || status.status === "expired") {
          throw new Error(`Order ${status.status}`);
        }
        return status;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error("Order monitoring timeout");
  }

  // ----------------------------------------
  // WebSocket
  // ----------------------------------------

  connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.apiKey
        ? `${CONFIG.WS_URL}?api_key=${this.apiKey}`
        : CONFIG.WS_URL;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = (error) => reject(error);
    });
  }

  subscribePrice(
    ticker: string,
    callback: (update: PriceUpdate) => void
  ): void {
    if (!this.ws) throw new Error("WebSocket not connected");

    this.ws.send(
      JSON.stringify({
        action: "subscribe",
        channel: "market",
        ticker,
      })
    );

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.type === "price_update" && data.ticker === ticker) {
        callback(data);
      }
    };
  }

  subscribeOrderbook(
    ticker: string,
    callback: (update: OrderbookUpdate) => void
  ): void {
    if (!this.ws) throw new Error("WebSocket not connected");

    this.ws.send(
      JSON.stringify({
        action: "subscribe",
        channel: "orderbook",
        ticker,
      })
    );

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.type === "orderbook_update" && data.ticker === ticker) {
        callback(data);
      }
    };
  }

  subscribeTrades(
    ticker: string,
    callback: (update: TradeUpdate) => void
  ): void {
    if (!this.ws) throw new Error("WebSocket not connected");

    this.ws.send(
      JSON.stringify({
        action: "subscribe",
        channel: "trades",
        ticker,
      })
    );

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.type === "trade" && data.ticker === ticker) {
        callback(data);
      }
    };
  }

  unsubscribe(channel: "market" | "orderbook" | "trades", ticker: string): void {
    if (!this.ws) return;

    this.ws.send(
      JSON.stringify({
        action: "unsubscribe",
        channel,
        ticker,
      })
    );
  }

  closeWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  // ----------------------------------------
  // Utilities
  // ----------------------------------------

  getWalletAddress(): string | null {
    return this.keypair?.publicKey.toBase58() || null;
  }

  isWebSocketConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }
}

// ============================================
// Usage Example
// ============================================

async function example() {
  // Initialize client
  const client = new DFlowPredictionMarketClient({
    apiKey: process.env.DFLOW_API_KEY,
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    privateKey: process.env.SOLANA_PRIVATE_KEY, // Optional, for trading
  });

  // Query markets
  const { events } = await client.getEvents({ status: "active", limit: 10 });
  console.log(`Found ${events.length} active events`);

  if (events.length > 0) {
    const event = await client.getEvent(events[0].ticker);
    console.log(`Event: ${event.title}`);

    if (event.markets && event.markets.length > 0) {
      const market = event.markets[0];
      console.log(`Market: ${market.ticker}`);
      console.log(`YES: ${market.yes_price}, NO: ${market.no_price}`);

      // Get orderbook
      const orderbook = await client.getOrderbook(market.ticker);
      console.log(`Spread: ${orderbook.spread}`);

      // Get quote (no wallet needed)
      const quote = await client.getOrder({
        inputMint: CONFIG.USDC_MINT,
        outputMint: market.yes_mint,
        amount: "10000000", // 10 USDC
      });
      console.log(`Quote: ${Number(quote.outAmount) / 1e6} YES tokens`);
    }
  }

  // WebSocket example
  await client.connectWebSocket();
  client.subscribePrice("SAMPLE-MARKET", (update) => {
    console.log(`Price: YES=${update.yes_price}, NO=${update.no_price}`);
  });
}

// Export
export default DFlowPredictionMarketClient;
