/**
 * CoinGecko Solana API: Token Price Examples
 *
 * Demonstrates fetching token prices by contract address
 * using both Demo and Pro API configurations.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  demo: {
    baseUrl: 'https://api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-demo-api-key',
  },
  pro: {
    baseUrl: 'https://pro-api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-pro-api-key',
  },
};

const API_TYPE = (process.env.COINGECKO_API_TYPE || 'demo') as 'demo' | 'pro';
const API_KEY = process.env.COINGECKO_API_KEY!;
const BASE_URL = CONFIG[API_TYPE].baseUrl;
const HEADER_KEY = CONFIG[API_TYPE].headerKey;
const NETWORK = 'solana';

// Common Solana token addresses
const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  SOL: 'So11111111111111111111111111111111111111112',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};

// ============================================================================
// TYPES
// ============================================================================

interface TokenPriceResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      token_prices: Record<string, string>;
      market_cap_usd?: Record<string, string | null>;
      h24_volume_usd?: Record<string, string>;
      h24_price_change_percentage?: Record<string, string>;
      total_reserve_in_usd?: Record<string, string>;
      last_trade_timestamp?: Record<string, number>;
    };
  };
}

interface TokenPriceData {
  address: string;
  priceUsd: number;
  marketCapUsd?: number | null;
  volume24h?: number;
  priceChange24h?: number;
  lastTradeTimestamp?: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchApi<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    headers: {
      [HEADER_KEY]: API_KEY,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ============================================================================
// EXAMPLE 1: Get Single Token Price
// ============================================================================

async function getTokenPrice(tokenAddress: string): Promise<number | null> {
  const data = await fetchApi<TokenPriceResponse>(
    `/simple/networks/${NETWORK}/token_price/${tokenAddress}`
  );

  const price = data.data?.attributes?.token_prices?.[tokenAddress];
  return price ? parseFloat(price) : null;
}

// ============================================================================
// EXAMPLE 2: Get Token Price with Market Data
// ============================================================================

async function getTokenPriceWithData(tokenAddress: string): Promise<TokenPriceData | null> {
  const data = await fetchApi<TokenPriceResponse>(
    `/simple/networks/${NETWORK}/token_price/${tokenAddress}`,
    {
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_24hr_price_change: 'true',
    }
  );

  const attrs = data.data?.attributes;
  if (!attrs?.token_prices?.[tokenAddress]) {
    return null;
  }

  return {
    address: tokenAddress,
    priceUsd: parseFloat(attrs.token_prices[tokenAddress]),
    marketCapUsd: attrs.market_cap_usd?.[tokenAddress]
      ? parseFloat(attrs.market_cap_usd[tokenAddress]!)
      : null,
    volume24h: attrs.h24_volume_usd?.[tokenAddress]
      ? parseFloat(attrs.h24_volume_usd[tokenAddress])
      : undefined,
    priceChange24h: attrs.h24_price_change_percentage?.[tokenAddress]
      ? parseFloat(attrs.h24_price_change_percentage[tokenAddress])
      : undefined,
    lastTradeTimestamp: attrs.last_trade_timestamp?.[tokenAddress],
  };
}

// ============================================================================
// EXAMPLE 3: Get Multiple Token Prices (Batch)
// ============================================================================

async function getMultipleTokenPrices(
  addresses: string[]
): Promise<Map<string, TokenPriceData>> {
  const addressList = addresses.join(',');

  const data = await fetchApi<TokenPriceResponse>(
    `/simple/networks/${NETWORK}/token_price/${addressList}`,
    {
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_24hr_price_change: 'true',
    }
  );

  const results = new Map<string, TokenPriceData>();
  const attrs = data.data?.attributes;

  if (!attrs) return results;

  for (const address of addresses) {
    if (attrs.token_prices?.[address]) {
      results.set(address, {
        address,
        priceUsd: parseFloat(attrs.token_prices[address]),
        marketCapUsd: attrs.market_cap_usd?.[address]
          ? parseFloat(attrs.market_cap_usd[address]!)
          : null,
        volume24h: attrs.h24_volume_usd?.[address]
          ? parseFloat(attrs.h24_volume_usd[address])
          : undefined,
        priceChange24h: attrs.h24_price_change_percentage?.[address]
          ? parseFloat(attrs.h24_price_change_percentage[address])
          : undefined,
      });
    }
  }

  return results;
}

// ============================================================================
// EXAMPLE 4: Price Monitoring with Polling
// ============================================================================

async function monitorTokenPrice(
  tokenAddress: string,
  intervalMs: number = 30000,
  callback: (price: number) => void
): Promise<() => void> {
  let isRunning = true;

  const poll = async () => {
    while (isRunning) {
      try {
        const price = await getTokenPrice(tokenAddress);
        if (price !== null) {
          callback(price);
        }
      } catch (error) {
        console.error('Price fetch error:', error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  poll();

  // Return stop function
  return () => {
    isRunning = false;
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('CoinGecko Token Price Examples\n');
  console.log(`API Type: ${API_TYPE}`);
  console.log(`Network: ${NETWORK}\n`);

  // Example 1: Single token price
  console.log('--- Example 1: Single Token Price ---');
  const solPrice = await getTokenPrice(TOKENS.SOL);
  console.log(`SOL Price: $${solPrice?.toFixed(4)}\n`);

  // Example 2: Token price with market data
  console.log('--- Example 2: Token Price with Market Data ---');
  const jupData = await getTokenPriceWithData(TOKENS.JUP);
  if (jupData) {
    console.log(`JUP Price: $${jupData.priceUsd.toFixed(6)}`);
    console.log(`Market Cap: $${jupData.marketCapUsd?.toLocaleString() ?? 'N/A'}`);
    console.log(`24h Volume: $${jupData.volume24h?.toLocaleString() ?? 'N/A'}`);
    console.log(`24h Change: ${jupData.priceChange24h?.toFixed(2)}%\n`);
  }

  // Example 3: Multiple token prices
  console.log('--- Example 3: Multiple Token Prices ---');
  const prices = await getMultipleTokenPrices([
    TOKENS.SOL,
    TOKENS.USDC,
    TOKENS.JUP,
    TOKENS.BONK,
  ]);

  prices.forEach((data, address) => {
    const symbol = Object.entries(TOKENS).find(([, addr]) => addr === address)?.[0] ?? 'Unknown';
    console.log(`${symbol}: $${data.priceUsd.toFixed(8)} (${data.priceChange24h?.toFixed(2)}%)`);
  });

  // Example 4: Price monitoring (commented out to avoid continuous polling)
  // console.log('\n--- Example 4: Price Monitoring ---');
  // const stopMonitoring = await monitorTokenPrice(TOKENS.SOL, 10000, (price) => {
  //   console.log(`SOL: $${price.toFixed(4)} at ${new Date().toISOString()}`);
  // });
  // setTimeout(stopMonitoring, 60000); // Stop after 1 minute
}

main().catch(console.error);
