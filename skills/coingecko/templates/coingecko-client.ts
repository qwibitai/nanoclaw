/**
 * CoinGecko Solana API Client Template
 *
 * A production-ready client for the CoinGecko Onchain API.
 * Copy this file to your project and customize as needed.
 *
 * Features:
 * - Support for both Demo and Pro APIs
 * - Built-in rate limiting
 * - Comprehensive error handling
 * - TypeScript types for all responses
 * - All major endpoints implemented
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Set environment variables:
 *    - COINGECKO_API_KEY: Your API key
 *    - COINGECKO_API_TYPE: 'demo' or 'pro'
 * 3. Import and use the client
 *
 * Example:
 * ```typescript
 * import { CoinGeckoClient } from './coingecko-client';
 *
 * const client = CoinGeckoClient.create();
 * const price = await client.tokens.getPrice('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
 * ```
 */

// ============================================================================
// TYPES
// ============================================================================

export interface CoinGeckoClientConfig {
  apiKey: string;
  apiType: 'demo' | 'pro';
  network?: string;
}

export interface TokenPrice {
  address: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24h: number;
  priceChange24h: number;
  lastTradeTimestamp: number | null;
}

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl: string | null;
  description: string | null;
  websites: string[];
  socials: {
    twitter: string | null;
    telegram: string | null;
    discord: string | null;
  };
  priceUsd: number;
  fdvUsd: number;
  marketCapUsd: number | null;
  totalSupply: string;
  volume24h: number;
  priceChange: {
    h1: number;
    h6: number;
    h24: number;
  };
}

export interface PoolInfo {
  address: string;
  name: string;
  dex: string | null;
  baseToken: TokenRef | null;
  quoteToken: TokenRef | null;
  reserveUsd: number;
  fdvUsd: number;
  marketCapUsd: number | null;
  baseTokenPrice: number;
  quoteTokenPrice: number;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  volume: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  transactions: {
    m5: TxCount;
    h1: TxCount;
    h24: TxCount;
  };
  createdAt: Date;
}

interface TokenRef {
  address: string;
  symbol: string;
  name: string;
}

interface TxCount {
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
}

export interface Candle {
  timestamp: number;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  txHash: string;
  blockNumber: number;
  timestamp: Date;
  type: 'buy' | 'sell';
  fromAmount: string;
  toAmount: string;
  priceUsd: number;
  volumeUsd: number;
  trader: string;
}

export interface DexInfo {
  id: string;
  name: string;
}

export type Timeframe = 'day' | 'hour' | 'minute';
export type TrendingDuration = '5m' | '1h' | '6h' | '24h';

// ============================================================================
// RATE LIMITER
// ============================================================================

class RateLimiter {
  private timestamps: number[] = [];
  private maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);

    if (this.timestamps.length >= this.maxPerMinute) {
      const waitTime = 60000 - (now - this.timestamps[0]);
      await new Promise((r) => setTimeout(r, waitTime + 100));
      return this.acquire();
    }

    this.timestamps.push(Date.now());
  }
}

// ============================================================================
// API ERROR
// ============================================================================

export class CoinGeckoError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public endpoint: string
  ) {
    super(message);
    this.name = 'CoinGeckoError';
  }
}

// ============================================================================
// COINGECKO CLIENT
// ============================================================================

export class CoinGeckoClient {
  private baseUrl: string;
  private headerKey: string;
  private apiKey: string;
  private network: string;
  private rateLimiter: RateLimiter;

  // Sub-clients for organized access
  public tokens: TokenClient;
  public pools: PoolClient;
  public ohlcv: OHLCVClient;
  public trades: TradeClient;
  public dexes: DexClient;

  private constructor(config: CoinGeckoClientConfig) {
    this.apiKey = config.apiKey;
    this.network = config.network || 'solana';

    if (config.apiType === 'pro') {
      this.baseUrl = 'https://pro-api.coingecko.com/api/v3/onchain';
      this.headerKey = 'x-cg-pro-api-key';
      this.rateLimiter = new RateLimiter(500);
    } else {
      this.baseUrl = 'https://api.coingecko.com/api/v3/onchain';
      this.headerKey = 'x-cg-demo-api-key';
      this.rateLimiter = new RateLimiter(30);
    }

    // Initialize sub-clients
    this.tokens = new TokenClient(this);
    this.pools = new PoolClient(this);
    this.ohlcv = new OHLCVClient(this);
    this.trades = new TradeClient(this);
    this.dexes = new DexClient(this);
  }

  /**
   * Create a new client from environment variables
   */
  static create(): CoinGeckoClient {
    const apiKey = process.env.COINGECKO_API_KEY;
    if (!apiKey) {
      throw new Error('COINGECKO_API_KEY environment variable is required');
    }

    return new CoinGeckoClient({
      apiKey,
      apiType: (process.env.COINGECKO_API_TYPE || 'demo') as 'demo' | 'pro',
      network: process.env.COINGECKO_NETWORK || 'solana',
    });
  }

  /**
   * Create a new client with explicit configuration
   */
  static createWithConfig(config: CoinGeckoClientConfig): CoinGeckoClient {
    return new CoinGeckoClient(config);
  }

  /**
   * Internal fetch method with rate limiting and error handling
   */
  async fetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    await this.rateLimiter.acquire();

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const response = await fetch(url.toString(), {
      headers: {
        [this.headerKey]: this.apiKey,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Invalid API key'
          : response.status === 429
            ? 'Rate limit exceeded'
            : response.status === 404
              ? 'Resource not found'
              : `API error: ${response.status}`;

      throw new CoinGeckoError(message, response.status, endpoint);
    }

    return response.json();
  }

  get networkId(): string {
    return this.network;
  }
}

// ============================================================================
// TOKEN CLIENT
// ============================================================================

class TokenClient {
  constructor(private client: CoinGeckoClient) {}

  async getPrice(address: string): Promise<TokenPrice | null> {
    const data = await this.client.fetch<any>(
      `/simple/networks/${this.client.networkId}/token_price/${address}`,
      {
        include_market_cap: 'true',
        include_24hr_vol: 'true',
        include_24hr_price_change: 'true',
      }
    );

    const attrs = data.data?.attributes;
    if (!attrs?.token_prices?.[address]) return null;

    return {
      address,
      priceUsd: parseFloat(attrs.token_prices[address]),
      marketCapUsd: attrs.market_cap_usd?.[address]
        ? parseFloat(attrs.market_cap_usd[address])
        : null,
      volume24h: parseFloat(attrs.h24_volume_usd?.[address] || '0'),
      priceChange24h: parseFloat(attrs.h24_price_change_percentage?.[address] || '0'),
      lastTradeTimestamp: attrs.last_trade_timestamp?.[address] || null,
    };
  }

  async getPrices(addresses: string[]): Promise<Map<string, TokenPrice>> {
    const results = new Map<string, TokenPrice>();

    const data = await this.client.fetch<any>(
      `/simple/networks/${this.client.networkId}/token_price/${addresses.join(',')}`,
      {
        include_market_cap: 'true',
        include_24hr_vol: 'true',
        include_24hr_price_change: 'true',
      }
    );

    const attrs = data.data?.attributes;
    if (!attrs) return results;

    for (const addr of addresses) {
      if (attrs.token_prices?.[addr]) {
        results.set(addr, {
          address: addr,
          priceUsd: parseFloat(attrs.token_prices[addr]),
          marketCapUsd: attrs.market_cap_usd?.[addr]
            ? parseFloat(attrs.market_cap_usd[addr])
            : null,
          volume24h: parseFloat(attrs.h24_volume_usd?.[addr] || '0'),
          priceChange24h: parseFloat(attrs.h24_price_change_percentage?.[addr] || '0'),
          lastTradeTimestamp: attrs.last_trade_timestamp?.[addr] || null,
        });
      }
    }

    return results;
  }

  async getInfo(address: string): Promise<TokenInfo | null> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/tokens/${address}`,
      { include: 'top_pools' }
    );

    const attrs = data.data?.attributes;
    if (!attrs) return null;

    return {
      address: attrs.address,
      name: attrs.name,
      symbol: attrs.symbol,
      decimals: attrs.decimals,
      imageUrl: attrs.image_url || null,
      description: attrs.description || null,
      websites: attrs.websites || [],
      socials: {
        twitter: attrs.twitter_handle || null,
        telegram: attrs.telegram_handle || null,
        discord: attrs.discord_url || null,
      },
      priceUsd: parseFloat(attrs.price_usd || '0'),
      fdvUsd: parseFloat(attrs.fdv_usd || '0'),
      marketCapUsd: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : null,
      totalSupply: attrs.total_supply || '0',
      volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
      priceChange: {
        h1: parseFloat(attrs.price_change_percentage?.h1 || '0'),
        h6: parseFloat(attrs.price_change_percentage?.h6 || '0'),
        h24: parseFloat(attrs.price_change_percentage?.h24 || '0'),
      },
    };
  }
}

// ============================================================================
// POOL CLIENT
// ============================================================================

class PoolClient {
  constructor(private client: CoinGeckoClient) {}

  async get(address: string): Promise<PoolInfo | null> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/pools/${address}`,
      { include: 'base_token,quote_token,dex' }
    );

    if (!data.data) return null;
    return this.parsePool(data.data, data.included);
  }

  async trending(duration: TrendingDuration = '24h'): Promise<PoolInfo[]> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/trending_pools`,
      { include: 'base_token,quote_token,dex', duration }
    );
    return this.parsePools(data);
  }

  async top(page: number = 1): Promise<PoolInfo[]> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/pools`,
      { include: 'base_token,quote_token,dex', page: page.toString() }
    );
    return this.parsePools(data);
  }

  async search(query: string): Promise<PoolInfo[]> {
    const data = await this.client.fetch<any>(`/search/pools`, {
      query,
      network: this.client.networkId,
      include: 'base_token,quote_token,dex',
    });
    return this.parsePools(data);
  }

  async byDex(
    dexIds: string[],
    options?: { minLiquidity?: number; minVolume?: number }
  ): Promise<PoolInfo[]> {
    const params: Record<string, string> = {
      networks: this.client.networkId,
      dexes: dexIds.join(','),
      include: 'base_token,quote_token,dex',
    };
    if (options?.minLiquidity) params.min_reserve_in_usd = options.minLiquidity.toString();
    if (options?.minVolume) params.min_h24_volume_usd = options.minVolume.toString();

    const data = await this.client.fetch<any>(`/pools/megafilter`, params);
    return this.parsePools(data);
  }

  private parsePool(item: any, included?: any[]): PoolInfo {
    const attrs = item.attributes;
    const inc = included || [];

    const findIncluded = (rel: any, type: string) =>
      inc.find((i) => i.id === rel?.data?.id && i.type === type);

    const base = findIncluded(item.relationships?.base_token, 'token');
    const quote = findIncluded(item.relationships?.quote_token, 'token');
    const dex = findIncluded(item.relationships?.dex, 'dex');

    return {
      address: attrs.address,
      name: attrs.name,
      dex: dex?.attributes?.name || null,
      baseToken: base
        ? { address: base.attributes.address, symbol: base.attributes.symbol, name: base.attributes.name }
        : null,
      quoteToken: quote
        ? { address: quote.attributes.address, symbol: quote.attributes.symbol, name: quote.attributes.name }
        : null,
      reserveUsd: parseFloat(attrs.reserve_in_usd || '0'),
      fdvUsd: parseFloat(attrs.fdv_usd || '0'),
      marketCapUsd: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : null,
      baseTokenPrice: parseFloat(attrs.base_token_price_usd || '0'),
      quoteTokenPrice: parseFloat(attrs.quote_token_price_usd || '0'),
      priceChange: {
        m5: parseFloat(attrs.price_change_percentage?.m5 || '0'),
        h1: parseFloat(attrs.price_change_percentage?.h1 || '0'),
        h6: parseFloat(attrs.price_change_percentage?.h6 || '0'),
        h24: parseFloat(attrs.price_change_percentage?.h24 || '0'),
      },
      volume: {
        m5: parseFloat(attrs.volume_usd?.m5 || '0'),
        h1: parseFloat(attrs.volume_usd?.h1 || '0'),
        h6: parseFloat(attrs.volume_usd?.h6 || '0'),
        h24: parseFloat(attrs.volume_usd?.h24 || '0'),
      },
      transactions: {
        m5: attrs.transactions?.m5 || { buys: 0, sells: 0, buyers: 0, sellers: 0 },
        h1: attrs.transactions?.h1 || { buys: 0, sells: 0, buyers: 0, sellers: 0 },
        h24: attrs.transactions?.h24 || { buys: 0, sells: 0, buyers: 0, sellers: 0 },
      },
      createdAt: new Date(attrs.pool_created_at),
    };
  }

  private parsePools(data: any): PoolInfo[] {
    return (data.data || []).map((item: any) => this.parsePool(item, data.included));
  }
}

// ============================================================================
// OHLCV CLIENT
// ============================================================================

class OHLCVClient {
  constructor(private client: CoinGeckoClient) {}

  async getPoolCandles(
    poolAddress: string,
    timeframe: Timeframe = 'hour',
    options?: { aggregate?: number; limit?: number; beforeTimestamp?: number }
  ): Promise<Candle[]> {
    const params: Record<string, string> = {
      aggregate: (options?.aggregate || 1).toString(),
      limit: (options?.limit || 100).toString(),
      currency: 'usd',
    };
    if (options?.beforeTimestamp) {
      params.before_timestamp = options.beforeTimestamp.toString();
    }

    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/pools/${poolAddress}/ohlcv/${timeframe}`,
      params
    );

    return (data.data?.attributes?.ohlcv_list || []).map((c: number[]) => ({
      timestamp: c[0],
      date: new Date(c[0] * 1000),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }

  async getTokenCandles(
    tokenAddress: string,
    timeframe: Timeframe = 'hour',
    options?: { aggregate?: number; limit?: number }
  ): Promise<Candle[]> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/tokens/${tokenAddress}/ohlcv/${timeframe}`,
      {
        aggregate: (options?.aggregate || 1).toString(),
        limit: (options?.limit || 100).toString(),
        currency: 'usd',
      }
    );

    return (data.data?.attributes?.ohlcv_list || []).map((c: number[]) => ({
      timestamp: c[0],
      date: new Date(c[0] * 1000),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
  }
}

// ============================================================================
// TRADE CLIENT
// ============================================================================

class TradeClient {
  constructor(private client: CoinGeckoClient) {}

  async getRecent(poolAddress: string, minVolumeUsd?: number): Promise<Trade[]> {
    const params: Record<string, string> = {};
    if (minVolumeUsd) {
      params.trade_volume_in_usd_greater_than = minVolumeUsd.toString();
    }

    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/pools/${poolAddress}/trades`,
      params
    );

    return (data.data || []).map((item: any) => ({
      txHash: item.attributes.tx_hash,
      blockNumber: item.attributes.block_number,
      timestamp: new Date(item.attributes.block_timestamp),
      type: item.attributes.kind,
      fromAmount: item.attributes.from_token_amount,
      toAmount: item.attributes.to_token_amount,
      priceUsd: parseFloat(item.attributes.price_to_in_usd || '0'),
      volumeUsd: parseFloat(item.attributes.volume_in_usd || '0'),
      trader: item.attributes.tx_from_address,
    }));
  }
}

// ============================================================================
// DEX CLIENT
// ============================================================================

class DexClient {
  constructor(private client: CoinGeckoClient) {}

  async list(): Promise<DexInfo[]> {
    const data = await this.client.fetch<any>(
      `/networks/${this.client.networkId}/dexes`
    );

    return (data.data || []).map((item: any) => ({
      id: item.id,
      name: item.attributes.name,
    }));
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default CoinGeckoClient;
