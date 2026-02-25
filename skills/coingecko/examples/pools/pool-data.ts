/**
 * CoinGecko Solana API: Pool Data Examples
 *
 * Demonstrates fetching pool data including trending pools,
 * pool details by address, and pool search functionality.
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

// ============================================================================
// TYPES
// ============================================================================

interface PoolAttributes {
  address: string;
  name: string;
  pool_created_at: string;
  fdv_usd: string;
  market_cap_usd: string | null;
  reserve_in_usd: string;
  base_token_price_usd: string;
  quote_token_price_usd: string;
  price_change_percentage: {
    m5: string;
    h1: string;
    h6: string;
    h24: string;
  };
  transactions: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume_usd: {
    m5: string;
    h1: string;
    h6: string;
    h24: string;
  };
}

interface PoolResponse {
  data: {
    id: string;
    type: string;
    attributes: PoolAttributes;
    relationships?: {
      base_token?: { data: { id: string } };
      quote_token?: { data: { id: string } };
      dex?: { data: { id: string } };
    };
  };
  included?: Array<{
    id: string;
    type: string;
    attributes: any;
  }>;
}

interface PoolListResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: PoolAttributes;
    relationships?: any;
  }>;
  included?: Array<{
    id: string;
    type: string;
    attributes: any;
  }>;
}

interface PoolData {
  address: string;
  name: string;
  createdAt: Date;
  fdvUsd: number;
  reserveUsd: number;
  baseTokenPrice: number;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  volume24h: number;
  transactions24h: {
    buys: number;
    sells: number;
  };
  dex?: string;
  baseToken?: string;
  quoteToken?: string;
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

function parsePoolData(item: PoolListResponse['data'][0], included?: any[]): PoolData {
  const attrs = item.attributes;

  // Find related entities from included
  let dex: string | undefined;
  let baseToken: string | undefined;
  let quoteToken: string | undefined;

  if (included) {
    const dexId = item.relationships?.dex?.data?.id;
    const baseTokenId = item.relationships?.base_token?.data?.id;
    const quoteTokenId = item.relationships?.quote_token?.data?.id;

    dex = included.find((i) => i.id === dexId && i.type === 'dex')?.attributes?.name;
    baseToken = included.find((i) => i.id === baseTokenId && i.type === 'token')?.attributes?.symbol;
    quoteToken = included.find((i) => i.id === quoteTokenId && i.type === 'token')?.attributes?.symbol;
  }

  return {
    address: attrs.address,
    name: attrs.name,
    createdAt: new Date(attrs.pool_created_at),
    fdvUsd: parseFloat(attrs.fdv_usd || '0'),
    reserveUsd: parseFloat(attrs.reserve_in_usd || '0'),
    baseTokenPrice: parseFloat(attrs.base_token_price_usd || '0'),
    priceChange: {
      m5: parseFloat(attrs.price_change_percentage?.m5 || '0'),
      h1: parseFloat(attrs.price_change_percentage?.h1 || '0'),
      h6: parseFloat(attrs.price_change_percentage?.h6 || '0'),
      h24: parseFloat(attrs.price_change_percentage?.h24 || '0'),
    },
    volume24h: parseFloat(attrs.volume_usd?.h24 || '0'),
    transactions24h: {
      buys: attrs.transactions?.h24?.buys || 0,
      sells: attrs.transactions?.h24?.sells || 0,
    },
    dex,
    baseToken,
    quoteToken,
  };
}

// ============================================================================
// EXAMPLE 1: Get Pool by Address
// ============================================================================

async function getPoolByAddress(poolAddress: string): Promise<PoolData | null> {
  const data = await fetchApi<PoolResponse>(`/networks/${NETWORK}/pools/${poolAddress}`, {
    include: 'base_token,quote_token,dex',
  });

  if (!data.data) return null;

  return parsePoolData(data.data as any, data.included);
}

// ============================================================================
// EXAMPLE 2: Get Trending Pools
// ============================================================================

async function getTrendingPools(
  duration: '5m' | '1h' | '6h' | '24h' = '24h',
  page: number = 1
): Promise<PoolData[]> {
  const data = await fetchApi<PoolListResponse>(`/networks/trending_pools`, {
    include: 'base_token,quote_token,dex,network',
    duration,
    page: page.toString(),
  });

  return data.data
    .filter((item) => {
      // Filter for Solana pools only
      const networkId = (item as any).relationships?.network?.data?.id;
      return networkId === NETWORK || networkId === 'solana';
    })
    .map((item) => parsePoolData(item, data.included));
}

// ============================================================================
// EXAMPLE 3: Get Top Pools on Solana
// ============================================================================

async function getTopPools(page: number = 1): Promise<PoolData[]> {
  const data = await fetchApi<PoolListResponse>(`/networks/${NETWORK}/pools`, {
    include: 'base_token,quote_token,dex',
    page: page.toString(),
  });

  return data.data.map((item) => parsePoolData(item, data.included));
}

// ============================================================================
// EXAMPLE 4: Search Pools
// ============================================================================

async function searchPools(query: string, page: number = 1): Promise<PoolData[]> {
  const data = await fetchApi<PoolListResponse>(`/search/pools`, {
    query,
    network: NETWORK,
    include: 'base_token,quote_token,dex',
    page: page.toString(),
  });

  return data.data.map((item) => parsePoolData(item, data.included));
}

// ============================================================================
// EXAMPLE 5: Get Pools by DEX (Megafilter)
// ============================================================================

async function getPoolsByDex(
  dexIds: string[],
  options?: {
    minLiquidity?: number;
    minVolume?: number;
    sort?: string;
  }
): Promise<PoolData[]> {
  const params: Record<string, string> = {
    networks: NETWORK,
    dexes: dexIds.join(','),
    include: 'base_token,quote_token,dex',
    page: '1',
  };

  if (options?.minLiquidity) {
    params.min_reserve_in_usd = options.minLiquidity.toString();
  }
  if (options?.minVolume) {
    params.min_h24_volume_usd = options.minVolume.toString();
  }
  if (options?.sort) {
    params.sort = options.sort;
  }

  const data = await fetchApi<PoolListResponse>(`/pools/megafilter`, params);

  return data.data.map((item) => parsePoolData(item, data.included));
}

// ============================================================================
// EXAMPLE 6: Get New Pools
// ============================================================================

async function getNewPools(page: number = 1): Promise<PoolData[]> {
  const data = await fetchApi<PoolListResponse>(`/networks/${NETWORK}/new_pools`, {
    include: 'base_token,quote_token,dex',
    page: page.toString(),
  });

  return data.data.map((item) => parsePoolData(item, data.included));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('CoinGecko Pool Data Examples\n');
  console.log(`API Type: ${API_TYPE}`);
  console.log(`Network: ${NETWORK}\n`);

  // Example 1: Get specific pool
  console.log('--- Example 1: Get Pool by Address ---');
  // SOL/USDC Raydium pool example
  const poolAddress = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  try {
    const pool = await getPoolByAddress(poolAddress);
    if (pool) {
      console.log(`Pool: ${pool.name}`);
      console.log(`DEX: ${pool.dex}`);
      console.log(`Liquidity: $${pool.reserveUsd.toLocaleString()}`);
      console.log(`24h Volume: $${pool.volume24h.toLocaleString()}`);
      console.log(`24h Change: ${pool.priceChange.h24.toFixed(2)}%\n`);
    }
  } catch (error) {
    console.log('Pool not found or error fetching\n');
  }

  // Example 2: Get trending pools
  console.log('--- Example 2: Trending Solana Pools (24h) ---');
  const trendingPools = await getTrendingPools('24h');
  trendingPools.slice(0, 5).forEach((pool, i) => {
    console.log(
      `${i + 1}. ${pool.name} (${pool.dex}) - $${pool.volume24h.toLocaleString()} vol`
    );
  });
  console.log();

  // Example 3: Get top pools
  console.log('--- Example 3: Top Solana Pools ---');
  const topPools = await getTopPools();
  topPools.slice(0, 5).forEach((pool, i) => {
    console.log(
      `${i + 1}. ${pool.name} - $${pool.reserveUsd.toLocaleString()} liquidity`
    );
  });
  console.log();

  // Example 4: Search pools
  console.log('--- Example 4: Search for SOL Pools ---');
  const solPools = await searchPools('SOL');
  solPools.slice(0, 5).forEach((pool, i) => {
    console.log(`${i + 1}. ${pool.name} (${pool.dex})`);
  });
  console.log();

  // Example 5: Get Raydium pools
  console.log('--- Example 5: High-Volume Raydium Pools ---');
  const raydiumPools = await getPoolsByDex(['raydium'], {
    minVolume: 100000,
    minLiquidity: 50000,
  });
  raydiumPools.slice(0, 5).forEach((pool, i) => {
    console.log(
      `${i + 1}. ${pool.name} - $${pool.volume24h.toLocaleString()} vol`
    );
  });
  console.log();

  // Example 6: Get new pools
  console.log('--- Example 6: Newest Solana Pools ---');
  const newPools = await getNewPools();
  newPools.slice(0, 5).forEach((pool, i) => {
    const age = Math.round((Date.now() - pool.createdAt.getTime()) / 60000);
    console.log(`${i + 1}. ${pool.name} (${pool.dex}) - ${age} mins old`);
  });
}

main().catch(console.error);
