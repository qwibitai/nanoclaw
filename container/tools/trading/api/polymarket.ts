/**
 * Polymarket API wrapper
 */

import { MarketAPI, MarketData, Order } from './common.js';

export class PolymarketAPI implements MarketAPI {
  platform: 'polymarket' = 'polymarket';
  private apiKey?: string;
  private baseUrl = 'https://gamma-api.polymarket.com';

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  async getMarketData(symbol: string): Promise<MarketData> {
    // For now, return mock data until we have real API keys
    // In production, this would call: GET /markets/{symbol}
    return {
      symbol,
      platform: 'polymarket',
      price: 0.5 + Math.random() * 0.3, // Mock price between 0.5-0.8
      volume: Math.random() * 1000000,
      openInterest: Math.random() * 5000000,
      timestamp: new Date().toISOString(),
      metadata: {
        mock: true,
        description: `Polymarket: ${symbol}`,
      },
    };
  }

  async getAllMarkets(): Promise<MarketData[]> {
    // In production: GET /markets?active=true
    // For now, return a few mock markets
    const mockSymbols = [
      'TRUMP_2024',
      'BTC_100K_2024',
      'FED_RATE_CUT_MARCH',
      'RECESSION_2024',
      'S&P_5000_2024',
    ];

    return Promise.all(mockSymbols.map(symbol => this.getMarketData(symbol)));
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
      // Paper trading: simulate immediate fill at limit price or current market price
      const marketData = await this.getMarketData(order.symbol);
      const filledPrice = order.limitPrice || marketData.price;

      return {
        orderId: `PAPER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        status: 'filled',
        filledPrice,
      };
    }

    // Live trading: would call Polymarket API
    // POST /orders with { symbol, side, size, price }
    throw new Error('Live trading not yet implemented - use paper mode for testing');
  }

  async getHistoricalData(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<MarketData[]> {
    // In production: GET /markets/{symbol}/history?start={startDate}&end={endDate}
    // For now, generate mock historical data
    const data: MarketData[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    let currentDate = new Date(start);
    let basePrice = 0.5 + Math.random() * 0.3;

    while (currentDate <= end) {
      // Simulate price movement with random walk
      basePrice += (Math.random() - 0.5) * 0.05;
      basePrice = Math.max(0.01, Math.min(0.99, basePrice));

      data.push({
        symbol,
        platform: 'polymarket',
        price: basePrice,
        volume: Math.random() * 500000,
        openInterest: Math.random() * 2000000,
        timestamp: currentDate.toISOString(),
        metadata: { mock: true },
      });

      currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000); // +1 day
    }

    return data;
  }
}
