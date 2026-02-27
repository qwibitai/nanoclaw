/**
 * Common interfaces and types for prediction market trading
 */

export interface MarketData {
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  price: number;
  volume?: number;
  openInterest?: number;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface Signal {
  symbol: string;
  strategy: string;
  action: 'buy' | 'sell';
  confidence: number; // 0-1
  entryPrice: number;
  reasoning: string;
  rsi2day?: number;
  rsi14day?: number;
  volatility?: number;
}

export interface Order {
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  action: 'buy' | 'sell';
  size: number;
  limitPrice?: number;
  stopLoss?: number;
  timeStopDays?: number;
}

export interface Position {
  id: number;
  symbol: string;
  platform: 'polymarket' | 'kalshi';
  entryPrice: number;
  size: number;
  entryDate: string;
  exitDate?: string;
  exitPrice?: number;
  status: 'open' | 'closed' | 'failed';
  pnl?: number;
  strategy: string;
  notes?: string;
}

export interface PerformanceMetrics {
  totalPnl: number;
  winRate: number; // 0-1
  totalTrades: number;
  winningTrades: number;
  maxDrawdown: number; // Negative percentage
  sharpeRatio?: number;
  avgWin?: number;
  avgLoss?: number;
  largestWin?: number;
  largestLoss?: number;
  consecutiveLosses?: number;
}

/**
 * Abstract market API interface
 */
export interface MarketAPI {
  platform: 'polymarket' | 'kalshi';

  /**
   * Fetch current market data for a symbol
   */
  getMarketData(symbol: string): Promise<MarketData>;

  /**
   * Fetch all active markets
   */
  getAllMarkets(): Promise<MarketData[]>;

  /**
   * Place an order (paper or live mode)
   */
  placeOrder(order: Order, mode: 'paper' | 'live'): Promise<{
    orderId: string;
    status: 'filled' | 'pending' | 'failed';
    filledPrice?: number;
    error?: string;
  }>;

  /**
   * Get historical prices for backtesting
   */
  getHistoricalData(symbol: string, startDate: string, endDate: string, interval?: string): Promise<MarketData[]>;

  /**
   * Search for markets by query string
   */
  searchMarkets?(query: string): Promise<MarketSearchResult[]>;
}

export interface MarketSearchResult {
  id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{ token_id: string; outcome: string }>;
  volume: number;
  endDate?: string;
}
