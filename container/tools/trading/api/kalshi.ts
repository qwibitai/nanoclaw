/**
 * Kalshi API wrapper
 *
 * Kalshi requires API key auth for all endpoints (unlike Polymarket's public CLOB).
 * Without credentials, all methods return empty results to avoid polluting
 * backtests with fake random-walk data.
 */

import { MarketAPI, MarketData, Order } from './common.js';

const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';

export class KalshiAPI implements MarketAPI {
  platform: 'kalshi' = 'kalshi';
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private get hasAuth(): boolean {
    return !!this.apiKey;
  }

  async getMarketData(symbol: string): Promise<MarketData> {
    if (!this.hasAuth) {
      return {
        symbol,
        platform: 'kalshi',
        price: 0,
        timestamp: new Date().toISOString(),
        metadata: { error: 'No Kalshi API key configured' },
      };
    }

    // TODO: implement authenticated GET /markets/{ticker}
    throw new Error('Kalshi authenticated API not yet implemented');
  }

  async getAllMarkets(): Promise<MarketData[]> {
    if (!this.hasAuth) return [];

    // TODO: implement authenticated GET /markets?status=open
    throw new Error('Kalshi authenticated API not yet implemented');
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
      if (marketData.price === 0) {
        return { orderId: '', status: 'failed', error: 'No Kalshi API key configured' };
      }
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
    _symbol: string,
    _startDate: string,
    _endDate: string,
    _interval?: string,
  ): Promise<MarketData[]> {
    if (!this.hasAuth) return [];

    // TODO: implement authenticated GET /markets/{ticker}/history
    throw new Error('Kalshi authenticated API not yet implemented');
  }
}
