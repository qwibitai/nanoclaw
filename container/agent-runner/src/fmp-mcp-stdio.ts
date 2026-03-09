/**
 * Financial Modelling Prep MCP Server
 * Provides price data for stocks, ETFs, crypto, forex, and commodities.
 * Caches ticker lookups in a SQLite DB at /workspace/group/fmp-cache.db.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const FMP_API_KEY = process.env.FMP_API_KEY!;
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const DB_PATH = '/workspace/group/fmp-cache.db';

// --- Lightweight SQLite cache using JSON file (no native module needed) ---
interface TickerCache {
  [companyName: string]: {
    ticker: string | null; // null = not supported
    supported: boolean;
    lastChecked: string;
  };
}

function loadCache(): TickerCache {
  const cachePath = DB_PATH.replace('.db', '.json');
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  } catch { /* corrupted cache, start fresh */ }
  return {};
}

function saveCache(cache: TickerCache): void {
  const cachePath = DB_PATH.replace('.db', '.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function getCachedTicker(companyName: string): { ticker: string | null; supported: boolean } | null {
  const cache = loadCache();
  const key = companyName.toLowerCase().trim();
  if (cache[key]) {
    return { ticker: cache[key].ticker, supported: cache[key].supported };
  }
  return null;
}

function setCachedTicker(companyName: string, ticker: string | null, supported: boolean): void {
  const cache = loadCache();
  const key = companyName.toLowerCase().trim();
  cache[key] = { ticker, supported, lastChecked: new Date().toISOString() };
  saveCache(cache);
}

async function fmpFetch(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${FMP_BASE}/${endpoint}`);
  url.searchParams.set('apikey', FMP_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`FMP API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- MCP Server ---

const server = new McpServer({
  name: 'fmp',
  version: '1.0.0',
});

server.tool(
  'search_ticker',
  `Search for a company/asset ticker symbol on Financial Modelling Prep. Results are cached in a local database so repeated lookups are instant. Use this before get_price if you're not sure of the exact ticker.`,
  {
    query: z.string().describe('Company name, ticker, or keyword to search (e.g., "Apple", "TSLA", "Bitcoin")'),
    limit: z.number().optional().default(5).describe('Max results to return (default 5)'),
  },
  async (args) => {
    // Check cache first
    const cached = getCachedTicker(args.query);
    if (cached) {
      if (cached.supported && cached.ticker) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cached result: "${args.query}" → ${cached.ticker} (supported)`,
          }],
        };
      } else if (!cached.supported) {
        return {
          content: [{
            type: 'text' as const,
            text: `Cached result: "${args.query}" is not supported on FMP.`,
          }],
        };
      }
    }

    try {
      const results = await fmpFetch('search', {
        query: args.query,
        limit: String(args.limit || 5),
      }) as Array<{ symbol: string; name: string; currency: string; stockExchange: string; exchangeShortName: string }>;

      if (!results || results.length === 0) {
        setCachedTicker(args.query, null, false);
        return {
          content: [{
            type: 'text' as const,
            text: `No results found for "${args.query}". This company/asset may not be supported by FMP.`,
          }],
        };
      }

      // Cache the top result
      setCachedTicker(args.query, results[0].symbol, true);
      // Also cache each result by its name
      for (const r of results) {
        setCachedTicker(r.name, r.symbol, true);
      }

      const formatted = results.map(r =>
        `${r.symbol} — ${r.name} (${r.exchangeShortName}, ${r.currency})`
      ).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Search results for "${args.query}":\n${formatted}`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error searching FMP: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_price',
  `Get the current/latest price for a financial instrument. Supports stocks, ETFs, crypto, forex, and commodities. Use search_ticker first if you don't know the exact symbol.`,
  {
    symbol: z.string().describe('Ticker symbol (e.g., "AAPL", "BTCUSD", "EURUSD")'),
  },
  async (args) => {
    try {
      const data = await fmpFetch(`quote/${encodeURIComponent(args.symbol)}`) as Array<{
        symbol: string;
        name: string;
        price: number;
        change: number;
        changesPercentage: number;
        dayLow: number;
        dayHigh: number;
        yearLow: number;
        yearHigh: number;
        marketCap: number;
        volume: number;
        open: number;
        previousClose: number;
        exchange: string;
        timestamp: number;
      }>;

      if (!data || data.length === 0) {
        setCachedTicker(args.symbol, null, false);
        return {
          content: [{
            type: 'text' as const,
            text: `No price data found for "${args.symbol}". It may not be supported by FMP. Try search_ticker to find the correct symbol.`,
          }],
        };
      }

      const q = data[0];
      // Cache this symbol as supported
      setCachedTicker(args.symbol, q.symbol, true);
      if (q.name) setCachedTicker(q.name, q.symbol, true);

      const lines = [
        `${q.symbol} — ${q.name}`,
        `Price: $${q.price}`,
        `Change: ${q.change >= 0 ? '+' : ''}${q.change} (${q.changesPercentage >= 0 ? '+' : ''}${q.changesPercentage.toFixed(2)}%)`,
        `Day Range: $${q.dayLow} – $${q.dayHigh}`,
        `52-Week Range: $${q.yearLow} – $${q.yearHigh}`,
        q.marketCap ? `Market Cap: $${(q.marketCap / 1e9).toFixed(2)}B` : null,
        q.volume ? `Volume: ${q.volume.toLocaleString()}` : null,
        `Open: $${q.open} | Prev Close: $${q.previousClose}`,
        `Exchange: ${q.exchange}`,
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text' as const, text: lines }] };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error fetching price: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_price_history',
  `Get historical daily prices for a symbol. Useful for charts, trend analysis, or calculating returns over a period.`,
  {
    symbol: z.string().describe('Ticker symbol (e.g., "AAPL")'),
    from: z.string().optional().describe('Start date in YYYY-MM-DD format'),
    to: z.string().optional().describe('End date in YYYY-MM-DD format'),
  },
  async (args) => {
    try {
      const params: Record<string, string> = {};
      if (args.from) params.from = args.from;
      if (args.to) params.to = args.to;

      const data = await fmpFetch(
        `historical-price-full/${encodeURIComponent(args.symbol)}`,
        params,
      ) as { symbol: string; historical: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> };

      if (!data?.historical || data.historical.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No historical data found for "${args.symbol}".`,
          }],
        };
      }

      // Return most recent 30 entries max to avoid overwhelming context
      const entries = data.historical.slice(0, 30);
      const header = `${data.symbol} — Historical Prices (${entries.length} days, most recent first):\n`;
      const rows = entries.map(d =>
        `${d.date}: O:$${d.open} H:$${d.high} L:$${d.low} C:$${d.close} V:${d.volume.toLocaleString()}`
      ).join('\n');

      return { content: [{ type: 'text' as const, text: header + rows }] };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error fetching history: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
