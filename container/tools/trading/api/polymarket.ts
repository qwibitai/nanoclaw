/**
 * Polymarket API wrapper — uses real CLOB REST API (public, no auth for reads)
 */

import { MarketAPI, MarketData, MarketSearchResult, Order } from './common.js';

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT = 15000;

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the clobTokenIds field from gamma-api market response.
 * Returns [{token_id, outcome}] pairs.
 */
function extractTokenIds(market: any): Array<{ token_id: string; outcome: string }> {
  try {
    const ids: string[] = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : market.clobTokenIds || [];
    const outcomes: string[] = typeof market.outcomes === 'string'
      ? JSON.parse(market.outcomes)
      : market.outcomes || ['Yes', 'No'];
    return ids.map((id, i) => ({ token_id: id, outcome: outcomes[i] || `Outcome ${i}` }));
  } catch {
    return [];
  }
}

export class PolymarketAPI implements MarketAPI {
  platform: 'polymarket' = 'polymarket';

  async getMarketData(tokenId: string): Promise<MarketData> {
    // Get midpoint price for a token ID
    const data = await fetchJson<{ mid: string }>(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
    const price = parseFloat(data.mid) || 0;
    // Approximate spread from book (optional, just return midpoint)
    return {
      symbol: tokenId,
      platform: 'polymarket',
      price,
      timestamp: new Date().toISOString(),
      metadata: { source: 'clob_midpoint' },
    };
  }

  async searchMarkets(query: string): Promise<MarketSearchResult[]> {
    const lowerQuery = query.toLowerCase();

    // Gamma-api _q param doesn't do text search — fetch events and filter client-side
    const events = await fetchJson<any[]>(
      `${GAMMA_BASE}/events?limit=100&active=true&closed=false`,
    );

    const results: MarketSearchResult[] = [];
    for (const event of (events || [])) {
      for (const m of (event.markets || [])) {
        const searchText = ((m.question || '') + ' ' + (event.title || '')).toLowerCase();
        if (!searchText.includes(lowerQuery)) continue;

        results.push({
          id: m.id || m.conditionId,
          question: m.question || m.title || '',
          slug: m.slug || '',
          active: m.active !== false,
          closed: m.closed === true,
          tokens: extractTokenIds(m),
          volume: parseFloat(m.volume || '0'),
          endDate: m.endDate || m.end_date_iso || undefined,
        });
      }
    }

    // Sort by volume descending
    results.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    return results.slice(0, 30);
  }

  async getAllMarkets(): Promise<MarketData[]> {
    // Default: search for bitcoin markets as a reasonable starting point
    const markets = await this.searchMarkets('bitcoin');
    const results: MarketData[] = [];
    // Get midpoint for the first YES token of each market (limit to avoid rate limits)
    for (const market of markets.slice(0, 10)) {
      const yesToken = market.tokens.find(t => t.outcome === 'Yes');
      if (!yesToken) continue;
      try {
        const md = await this.getMarketData(yesToken.token_id);
        md.metadata = {
          ...md.metadata,
          question: market.question,
          slug: market.slug,
          market_id: market.id,
        };
        results.push(md);
      } catch {
        // Skip on error
      }
    }
    return results;
  }

  async placeOrder(
    order: Order,
    mode: 'paper' | 'live',
  ): Promise<{
    orderId: string;
    status: 'filled' | 'pending' | 'failed';
    filledPrice?: number;
    error?: string;
  }> {
    if (mode === 'paper') {
      const marketData = await this.getMarketData(order.symbol);
      const filledPrice = order.limitPrice || marketData.price;
      return {
        orderId: `PAPER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        status: 'filled',
        filledPrice,
      };
    }
    throw new Error('Live trading not yet implemented - use paper mode for testing');
  }

  async getHistoricalData(
    tokenId: string,
    startDate: string,
    endDate: string,
    interval?: string,
  ): Promise<MarketData[]> {
    // CLOB price-history endpoint
    // interval: 1m, 1h, 6h, 1d, 1w, max
    // fidelity: number of data points to return
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const rangeMs = end - start;

    // Auto-select interval if not provided
    let apiInterval = interval || '1d';
    if (!interval) {
      if (rangeMs <= 60 * 60 * 1000) apiInterval = '1m';        // <= 1 hour
      else if (rangeMs <= 24 * 60 * 60 * 1000) apiInterval = '1h'; // <= 1 day
      else if (rangeMs <= 7 * 24 * 60 * 60 * 1000) apiInterval = '1d'; // <= 1 week
      else apiInterval = '1d';
    }

    // Calculate fidelity based on range and interval
    const intervalMs: Record<string, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '6h': 21_600_000,
      '1d': 86_400_000,
      '1w': 604_800_000,
    };
    const stepMs = intervalMs[apiInterval] || 86_400_000;
    const fidelity = Math.min(Math.max(Math.ceil(rangeMs / stepMs), 10), 10000);

    // Map sub-hour intervals to 1m for the API (we'll get granular data)
    const apiIntervalParam = ['5m', '15m'].includes(apiInterval) ? '1m' : apiInterval;

    const url = `${CLOB_BASE}/prices-history?market=${tokenId}&interval=${apiIntervalParam}&fidelity=${fidelity}`;

    const data = await fetchJson<{ history: Array<{ t: number; p: number }> }>(url);

    if (!data.history || !Array.isArray(data.history)) {
      return [];
    }

    return data.history
      .filter(point => {
        const ts = point.t * 1000; // API returns seconds
        return ts >= start && ts <= end;
      })
      .map(point => ({
        symbol: tokenId,
        platform: 'polymarket' as const,
        price: point.p,
        timestamp: new Date(point.t * 1000).toISOString(),
        metadata: { source: 'clob_price_history', interval: apiInterval },
      }));
  }
}
