/**
 * CoinGecko Solana API: Full Integration Example
 *
 * A complete example demonstrating how to build a comprehensive
 * CoinGecko client for Solana with all major features.
 */

// ============================================================================
// TYPES
// ============================================================================

interface CoinGeckoConfig {
  apiKey: string;
  apiType: 'demo' | 'pro';
}

interface TokenPrice {
  address: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24h: number;
  priceChange24h: number;
  lastTradeTimestamp: number | null;
}

interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl: string | null;
  priceUsd: number;
  fdvUsd: number;
  marketCapUsd: number | null;
  volume24h: number;
  priceChange24h: number;
}

interface PoolInfo {
  address: string;
  name: string;
  dex: string | null;
  baseToken: { address: string; symbol: string } | null;
  quoteToken: { address: string; symbol: string } | null;
  reserveUsd: number;
  volume24h: number;
  priceChange24h: number;
  transactions24h: { buys: number; sells: number };
  createdAt: Date;
}

interface Candle {
  timestamp: number;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  txHash: string;
  timestamp: Date;
  type: 'buy' | 'sell';
  volumeUsd: number;
  priceUsd: number;
  trader: string;
}

interface DexInfo {
  id: string;
  name: string;
}

// ============================================================================
// COINGECKO SOLANA CLIENT
// ============================================================================

export class CoinGeckoSolanaClient {
  private baseUrl: string;
  private headerKey: string;
  private apiKey: string;
  private network = 'solana';

  // Rate limiting
  private callTimestamps: number[] = [];
  private maxCallsPerMinute: number;

  constructor(config: CoinGeckoConfig) {
    this.apiKey = config.apiKey;

    if (config.apiType === 'pro') {
      this.baseUrl = 'https://pro-api.coingecko.com/api/v3/onchain';
      this.headerKey = 'x-cg-pro-api-key';
      this.maxCallsPerMinute = 500;
    } else {
      this.baseUrl = 'https://api.coingecko.com/api/v3/onchain';
      this.headerKey = 'x-cg-demo-api-key';
      this.maxCallsPerMinute = 30;
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter((t) => now - t < 60000);

    if (this.callTimestamps.length >= this.maxCallsPerMinute) {
      const oldestCall = this.callTimestamps[0];
      const waitTime = 60000 - (now - oldestCall);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.callTimestamps.push(Date.now());
  }

  private async fetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    await this.waitForRateLimit();

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        [this.headerKey]: this.apiKey,
        Accept: 'application/json',
      },
    });

    if (response.status === 401) {
      throw new Error('Invalid API key');
    }
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    }
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  // --------------------------------------------------------------------------
  // TOKEN METHODS
  // --------------------------------------------------------------------------

  async getTokenPrice(address: string): Promise<TokenPrice | null> {
    const data = await this.fetch<any>(
      `/simple/networks/${this.network}/token_price/${address}`,
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

  async getMultipleTokenPrices(addresses: string[]): Promise<Map<string, TokenPrice>> {
    const results = new Map<string, TokenPrice>();
    const data = await this.fetch<any>(
      `/simple/networks/${this.network}/token_price/${addresses.join(',')}`,
      {
        include_market_cap: 'true',
        include_24hr_vol: 'true',
        include_24hr_price_change: 'true',
      }
    );

    const attrs = data.data?.attributes;
    if (!attrs) return results;

    for (const address of addresses) {
      if (attrs.token_prices?.[address]) {
        results.set(address, {
          address,
          priceUsd: parseFloat(attrs.token_prices[address]),
          marketCapUsd: attrs.market_cap_usd?.[address]
            ? parseFloat(attrs.market_cap_usd[address])
            : null,
          volume24h: parseFloat(attrs.h24_volume_usd?.[address] || '0'),
          priceChange24h: parseFloat(attrs.h24_price_change_percentage?.[address] || '0'),
          lastTradeTimestamp: attrs.last_trade_timestamp?.[address] || null,
        });
      }
    }

    return results;
  }

  async getTokenInfo(address: string): Promise<TokenInfo | null> {
    const data = await this.fetch<any>(
      `/networks/${this.network}/tokens/${address}`,
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
      priceUsd: parseFloat(attrs.price_usd || '0'),
      fdvUsd: parseFloat(attrs.fdv_usd || '0'),
      marketCapUsd: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : null,
      volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
      priceChange24h: parseFloat(attrs.price_change_percentage?.h24 || '0'),
    };
  }

  // --------------------------------------------------------------------------
  // POOL METHODS
  // --------------------------------------------------------------------------

  async getPoolInfo(address: string): Promise<PoolInfo | null> {
    const data = await this.fetch<any>(
      `/networks/${this.network}/pools/${address}`,
      { include: 'base_token,quote_token,dex' }
    );

    const attrs = data.data?.attributes;
    if (!attrs) return null;

    // Extract included entities
    const included = data.included || [];
    const baseTokenData = included.find(
      (i: any) => i.id === data.data.relationships?.base_token?.data?.id
    );
    const quoteTokenData = included.find(
      (i: any) => i.id === data.data.relationships?.quote_token?.data?.id
    );
    const dexData = included.find(
      (i: any) => i.id === data.data.relationships?.dex?.data?.id
    );

    return {
      address: attrs.address,
      name: attrs.name,
      dex: dexData?.attributes?.name || null,
      baseToken: baseTokenData
        ? { address: baseTokenData.attributes.address, symbol: baseTokenData.attributes.symbol }
        : null,
      quoteToken: quoteTokenData
        ? { address: quoteTokenData.attributes.address, symbol: quoteTokenData.attributes.symbol }
        : null,
      reserveUsd: parseFloat(attrs.reserve_in_usd || '0'),
      volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
      priceChange24h: parseFloat(attrs.price_change_percentage?.h24 || '0'),
      transactions24h: {
        buys: attrs.transactions?.h24?.buys || 0,
        sells: attrs.transactions?.h24?.sells || 0,
      },
      createdAt: new Date(attrs.pool_created_at),
    };
  }

  async getTrendingPools(duration: '5m' | '1h' | '6h' | '24h' = '24h'): Promise<PoolInfo[]> {
    const data = await this.fetch<any>(`/networks/${this.network}/trending_pools`, {
      include: 'base_token,quote_token,dex',
      duration,
    });

    return this.parsePoolList(data);
  }

  async getTopPools(page: number = 1): Promise<PoolInfo[]> {
    const data = await this.fetch<any>(`/networks/${this.network}/pools`, {
      include: 'base_token,quote_token,dex',
      page: page.toString(),
    });

    return this.parsePoolList(data);
  }

  async searchPools(query: string): Promise<PoolInfo[]> {
    const data = await this.fetch<any>(`/search/pools`, {
      query,
      network: this.network,
      include: 'base_token,quote_token,dex',
    });

    return this.parsePoolList(data);
  }

  async getPoolsByDex(
    dexIds: string[],
    options?: { minLiquidity?: number; minVolume?: number }
  ): Promise<PoolInfo[]> {
    const params: Record<string, string> = {
      networks: this.network,
      dexes: dexIds.join(','),
      include: 'base_token,quote_token,dex',
    };

    if (options?.minLiquidity) {
      params.min_reserve_in_usd = options.minLiquidity.toString();
    }
    if (options?.minVolume) {
      params.min_h24_volume_usd = options.minVolume.toString();
    }

    const data = await this.fetch<any>(`/pools/megafilter`, params);
    return this.parsePoolList(data);
  }

  private parsePoolList(data: any): PoolInfo[] {
    const included = data.included || [];

    return (data.data || []).map((item: any) => {
      const attrs = item.attributes;
      const baseTokenData = included.find(
        (i: any) => i.id === item.relationships?.base_token?.data?.id
      );
      const quoteTokenData = included.find(
        (i: any) => i.id === item.relationships?.quote_token?.data?.id
      );
      const dexData = included.find(
        (i: any) => i.id === item.relationships?.dex?.data?.id
      );

      return {
        address: attrs.address,
        name: attrs.name,
        dex: dexData?.attributes?.name || null,
        baseToken: baseTokenData
          ? { address: baseTokenData.attributes.address, symbol: baseTokenData.attributes.symbol }
          : null,
        quoteToken: quoteTokenData
          ? { address: quoteTokenData.attributes.address, symbol: quoteTokenData.attributes.symbol }
          : null,
        reserveUsd: parseFloat(attrs.reserve_in_usd || '0'),
        volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
        priceChange24h: parseFloat(attrs.price_change_percentage?.h24 || '0'),
        transactions24h: {
          buys: attrs.transactions?.h24?.buys || 0,
          sells: attrs.transactions?.h24?.sells || 0,
        },
        createdAt: new Date(attrs.pool_created_at),
      };
    });
  }

  // --------------------------------------------------------------------------
  // OHLCV METHODS
  // --------------------------------------------------------------------------

  async getPoolOHLCV(
    poolAddress: string,
    timeframe: 'day' | 'hour' | 'minute' = 'hour',
    aggregate: number = 1,
    limit: number = 100
  ): Promise<Candle[]> {
    const data = await this.fetch<any>(
      `/networks/${this.network}/pools/${poolAddress}/ohlcv/${timeframe}`,
      {
        aggregate: aggregate.toString(),
        limit: limit.toString(),
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

  // --------------------------------------------------------------------------
  // TRADE METHODS
  // --------------------------------------------------------------------------

  async getRecentTrades(poolAddress: string): Promise<Trade[]> {
    const data = await this.fetch<any>(
      `/networks/${this.network}/pools/${poolAddress}/trades`
    );

    return (data.data || []).map((item: any) => ({
      txHash: item.attributes.tx_hash,
      timestamp: new Date(item.attributes.block_timestamp),
      type: item.attributes.kind,
      volumeUsd: parseFloat(item.attributes.volume_in_usd || '0'),
      priceUsd: parseFloat(item.attributes.price_to_in_usd || '0'),
      trader: item.attributes.tx_from_address,
    }));
  }

  // --------------------------------------------------------------------------
  // DEX METHODS
  // --------------------------------------------------------------------------

  async getDexes(): Promise<DexInfo[]> {
    const data = await this.fetch<any>(`/networks/${this.network}/dexes`);

    return (data.data || []).map((item: any) => ({
      id: item.id,
      name: item.attributes.name,
    }));
  }
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

async function main() {
  const client = new CoinGeckoSolanaClient({
    apiKey: process.env.COINGECKO_API_KEY!,
    apiType: (process.env.COINGECKO_API_TYPE || 'demo') as 'demo' | 'pro',
  });

  console.log('CoinGecko Solana Client - Full Integration Example\n');

  // Token prices
  console.log('--- Token Prices ---');
  const solPrice = await client.getTokenPrice('So11111111111111111111111111111111111111112');
  console.log(`SOL: $${solPrice?.priceUsd.toFixed(4)} (${solPrice?.priceChange24h.toFixed(2)}%)\n`);

  // Token info
  console.log('--- Token Info ---');
  const jupInfo = await client.getTokenInfo('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  console.log(`${jupInfo?.name} (${jupInfo?.symbol})`);
  console.log(`Price: $${jupInfo?.priceUsd.toFixed(6)}`);
  console.log(`FDV: $${jupInfo?.fdvUsd.toLocaleString()}\n`);

  // Trending pools
  console.log('--- Trending Pools ---');
  const trending = await client.getTrendingPools('24h');
  trending.slice(0, 3).forEach((p, i) => {
    console.log(`${i + 1}. ${p.name} (${p.dex}) - $${p.volume24h.toLocaleString()} vol`);
  });
  console.log();

  // DEXes
  console.log('--- Available DEXes ---');
  const dexes = await client.getDexes();
  console.log(dexes.slice(0, 10).map((d) => d.name).join(', '));
}

main().catch(console.error);
