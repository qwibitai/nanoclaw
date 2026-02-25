/**
 * DFlow Prediction Market - Query Markets Example
 *
 * Demonstrates how to query prediction market metadata including:
 * - Events and their markets
 * - Market details and prices
 * - Orderbook data
 * - Trade history
 * - Outcome mint filtering
 */

import { PublicKey } from "@solana/web3.js";

// API Configuration
const METADATA_API = "https://api.prod.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY || "";

// Types
interface Event {
  ticker: string;
  title: string;
  description: string;
  status: "active" | "closed" | "determined" | "finalized";
  series_ticker: string;
  category: string;
  close_time: string;
  markets?: Market[];
}

interface Market {
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

interface OrderbookLevel {
  price: number;
  quantity: number;
}

interface Orderbook {
  ticker: string;
  timestamp: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  mid_price: number;
}

interface Trade {
  id: string;
  ticker: string;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  timestamp: string;
}

interface OutcomeMint {
  mint: string;
  market_ticker: string;
  outcome: "yes" | "no";
}

// Helper function for API requests
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  const response = await fetch(`${METADATA_API}${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error ${response.status}: ${error}`);
  }

  return response.json();
}

// ============================================
// Events API
// ============================================

/**
 * Get a single event by ticker
 */
async function getEvent(
  ticker: string,
  includeMarkets: boolean = true
): Promise<Event> {
  const params = new URLSearchParams();
  if (includeMarkets) {
    params.set("include_markets", "true");
  }

  return apiRequest<Event>(`/api/v1/event/${ticker}?${params}`);
}

/**
 * Get paginated list of events
 */
async function getEvents(options: {
  limit?: number;
  offset?: number;
  status?: string;
  category?: string;
}): Promise<{ events: Event[]; total: number }> {
  const params = new URLSearchParams();

  if (options.limit) params.set("limit", options.limit.toString());
  if (options.offset) params.set("offset", options.offset.toString());
  if (options.status) params.set("status", options.status);
  if (options.category) params.set("category", options.category);

  return apiRequest(`/api/v1/events?${params}`);
}

/**
 * Search for events and markets
 */
async function searchEvents(query: string): Promise<{
  results: Array<{
    type: "event" | "market";
    ticker: string;
    title: string;
    relevance_score: number;
  }>;
}> {
  const params = new URLSearchParams({ q: query });
  return apiRequest(`/api/v1/search?${params}`);
}

// ============================================
// Markets API
// ============================================

/**
 * Get a single market by ticker
 */
async function getMarket(ticker: string): Promise<Market> {
  return apiRequest<Market>(`/api/v1/market/${ticker}`);
}

/**
 * Get market by mint address
 */
async function getMarketByMint(mintAddress: string): Promise<Market> {
  return apiRequest<Market>(`/api/v1/market/by-mint/${mintAddress}`);
}

/**
 * Batch get multiple markets
 */
async function getMarketsBatch(
  tickers: string[],
  mints: string[] = []
): Promise<{ markets: Market[]; not_found: string[] }> {
  return apiRequest(`/api/v1/markets/batch`, {
    method: "POST",
    body: JSON.stringify({ tickers, mints }),
  });
}

/**
 * Get all outcome mints
 */
async function getOutcomeMints(
  minCloseTimestamp?: number
): Promise<{ outcome_mints: OutcomeMint[] }> {
  const params = new URLSearchParams();
  if (minCloseTimestamp) {
    params.set("min_close_timestamp", minCloseTimestamp.toString());
  }

  return apiRequest(`/api/v1/outcome_mints?${params}`);
}

/**
 * Filter addresses to find outcome mints
 */
async function filterOutcomeMints(addresses: string[]): Promise<{
  outcome_mints: OutcomeMint[];
  non_outcome_mints: string[];
}> {
  return apiRequest(`/api/v1/filter_outcome_mints`, {
    method: "POST",
    body: JSON.stringify({ addresses }),
  });
}

// ============================================
// Orderbook API
// ============================================

/**
 * Get orderbook for a market
 */
async function getOrderbook(
  ticker: string,
  depth: number = 10
): Promise<Orderbook> {
  const params = new URLSearchParams({ depth: depth.toString() });
  return apiRequest<Orderbook>(`/api/v1/orderbook/${ticker}?${params}`);
}

/**
 * Get orderbook by mint address
 */
async function getOrderbookByMint(
  mintAddress: string,
  depth: number = 10
): Promise<Orderbook> {
  const params = new URLSearchParams({ depth: depth.toString() });
  return apiRequest<Orderbook>(
    `/api/v1/orderbook/by-mint/${mintAddress}?${params}`
  );
}

// ============================================
// Trades API
// ============================================

/**
 * Get trade history for a market
 */
async function getTrades(options: {
  ticker?: string;
  limit?: number;
  offset?: number;
  startTime?: number;
  endTime?: number;
}): Promise<{ trades: Trade[]; total: number }> {
  const params = new URLSearchParams();

  if (options.ticker) params.set("ticker", options.ticker);
  if (options.limit) params.set("limit", options.limit.toString());
  if (options.offset) params.set("offset", options.offset.toString());
  if (options.startTime) params.set("start_time", options.startTime.toString());
  if (options.endTime) params.set("end_time", options.endTime.toString());

  return apiRequest(`/api/v1/trades?${params}`);
}

// ============================================
// Categories & Series API
// ============================================

/**
 * Get all categories
 */
async function getCategories(): Promise<{
  categories: Array<{ id: string; name: string; events_count: number }>;
}> {
  return apiRequest(`/api/v1/categories`);
}

/**
 * Get all series
 */
async function getSeries(category?: string): Promise<{
  series: Array<{
    ticker: string;
    title: string;
    category: string;
    events_count: number;
  }>;
}> {
  const params = new URLSearchParams();
  if (category) params.set("category", category);

  return apiRequest(`/api/v1/series?${params}`);
}

// ============================================
// Example Usage
// ============================================

async function main() {
  console.log("DFlow Prediction Market - Query Examples\n");
  console.log("=".repeat(50));

  try {
    // 1. Get all categories
    console.log("\n1. Fetching categories...");
    const { categories } = await getCategories();
    console.log("Available categories:");
    for (const cat of categories.slice(0, 5)) {
      console.log(`  - ${cat.name}: ${cat.events_count} events`);
    }

    // 2. Get active events
    console.log("\n2. Fetching active events...");
    const { events, total } = await getEvents({
      status: "active",
      limit: 5,
    });
    console.log(`Found ${total} active events. Showing first 5:`);
    for (const event of events) {
      console.log(`  - ${event.ticker}: ${event.title}`);
    }

    // 3. Get specific event with markets
    if (events.length > 0) {
      const eventTicker = events[0].ticker;
      console.log(`\n3. Fetching event details: ${eventTicker}`);
      const event = await getEvent(eventTicker, true);
      console.log(`  Title: ${event.title}`);
      console.log(`  Status: ${event.status}`);
      console.log(`  Category: ${event.category}`);
      console.log(`  Markets: ${event.markets?.length || 0}`);

      if (event.markets && event.markets.length > 0) {
        const market = event.markets[0];
        console.log(`\n  First market: ${market.ticker}`);
        console.log(`    YES price: ${market.yes_price}`);
        console.log(`    NO price: ${market.no_price}`);
        console.log(`    24h volume: $${market.volume_24h?.toLocaleString()}`);

        // 4. Get orderbook
        console.log(`\n4. Fetching orderbook for ${market.ticker}...`);
        const orderbook = await getOrderbook(market.ticker, 5);
        console.log(`  Mid price: ${orderbook.mid_price}`);
        console.log(`  Spread: ${orderbook.spread}`);
        console.log(`  Top bid: ${orderbook.bids[0]?.price} (${orderbook.bids[0]?.quantity} qty)`);
        console.log(`  Top ask: ${orderbook.asks[0]?.price} (${orderbook.asks[0]?.quantity} qty)`);

        // 5. Get recent trades
        console.log(`\n5. Fetching recent trades for ${market.ticker}...`);
        const { trades } = await getTrades({
          ticker: market.ticker,
          limit: 5,
        });
        console.log(`  Recent trades:`);
        for (const trade of trades) {
          console.log(
            `    ${trade.side.toUpperCase()} ${trade.quantity} @ ${trade.price} (${trade.outcome})`
          );
        }
      }
    }

    // 6. Search for events
    console.log("\n6. Searching for 'election' events...");
    const searchResults = await searchEvents("election");
    console.log(`  Found ${searchResults.results.length} results:`);
    for (const result of searchResults.results.slice(0, 3)) {
      console.log(`    [${result.type}] ${result.ticker}: ${result.title}`);
    }

    // 7. Filter outcome mints
    console.log("\n7. Checking if addresses are outcome mints...");
    const testAddresses = [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC (not outcome)
      "So11111111111111111111111111111111111111112", // SOL (not outcome)
    ];
    const filterResult = await filterOutcomeMints(testAddresses);
    console.log(`  Outcome mints: ${filterResult.outcome_mints.length}`);
    console.log(`  Non-outcome mints: ${filterResult.non_outcome_mints.length}`);

    console.log("\n" + "=".repeat(50));
    console.log("Examples completed successfully!");
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
  }
}

// Run examples
main();

// Export functions for use in other modules
export {
  getEvent,
  getEvents,
  getMarket,
  getMarketByMint,
  getMarketsBatch,
  getOutcomeMints,
  filterOutcomeMints,
  getOrderbook,
  getOrderbookByMint,
  getTrades,
  getCategories,
  getSeries,
  searchEvents,
};
