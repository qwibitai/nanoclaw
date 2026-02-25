---
name: coingecko
description: Complete CoinGecko Solana API integration for token prices, DEX pool data, OHLCV charts, trades, and market analytics. Use for building trading bots, portfolio trackers, price feeds, and on-chain data applications.
---

# CoinGecko Solana API Development Guide

A comprehensive guide for integrating CoinGecko's on-chain API for Solana. Access real-time token prices, DEX pool data, OHLCV charts, trade history, and market analytics across 1,700+ decentralized exchanges.

## Overview

CoinGecko's Solana API provides:
- **Token Prices**: Real-time prices by contract address (single or batch)
- **Pool Data**: Liquidity pool information, trending pools, top pools
- **OHLCV Charts**: Candlestick data for technical analysis
- **Trade History**: Recent trades for any pool
- **DEX Discovery**: List all DEXes operating on Solana
- **Search**: Find pools by token name, symbol, or address
- **Megafilter**: Advanced filtering across pools, tokens, and DEXes

### Key Features

| Feature | Description |
|---------|-------------|
| **250+ Networks** | Multi-chain support including Solana |
| **1,700+ DEXes** | Raydium, Orca, Jupiter, Meteora, Pump.fun, etc. |
| **15M+ Tokens** | Comprehensive token coverage |
| **Real-time Data** | Updates every 10-30 seconds |
| **Historical Data** | OHLCV charts and trade history |

---

## Quick Start

### Get Your API Key

1. **Demo API (Free)**: Visit [coingecko.com/en/api](https://www.coingecko.com/en/api)
2. **Pro API (Paid)**: Visit [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing)

### Environment Setup

```bash
# .env file
COINGECKO_API_KEY=your_api_key_here
COINGECKO_API_TYPE=demo  # or 'pro'
```

### API Configuration

```typescript
// Configuration for both Demo and Pro APIs
const CONFIG = {
  demo: {
    baseUrl: 'https://api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-demo-api-key',
    rateLimit: 30, // calls per minute
  },
  pro: {
    baseUrl: 'https://pro-api.coingecko.com/api/v3/onchain',
    headerKey: 'x-cg-pro-api-key',
    rateLimit: 500, // calls per minute (varies by plan)
  },
};

const apiType = process.env.COINGECKO_API_TYPE || 'demo';
const apiKey = process.env.COINGECKO_API_KEY;

const BASE_URL = CONFIG[apiType].baseUrl;
const HEADER_KEY = CONFIG[apiType].headerKey;

// Solana network identifier
const NETWORK = 'solana';
```

### Basic Token Price Fetch

```typescript
async function getTokenPrice(tokenAddress: string): Promise<number | null> {
  const url = `${BASE_URL}/simple/networks/${NETWORK}/token_price/${tokenAddress}`;

  const response = await fetch(url, {
    headers: {
      [HEADER_KEY]: apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data?.attributes?.token_prices?.[tokenAddress] ?? null;
}

// Usage
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const price = await getTokenPrice(USDC);
console.log(`USDC Price: $${price}`);
```

---

## API Endpoints Reference

### Simple Token Price

Get token prices by contract address.

**Endpoint**: `GET /simple/networks/{network}/token_price/{addresses}`

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | string | Yes | Network ID (`solana`) |
| `addresses` | string | Yes | Comma-separated token addresses (max 30 Demo, 100 Pro) |
| `include_market_cap` | boolean | No | Include market cap data |
| `include_24hr_vol` | boolean | No | Include 24h volume |
| `include_24hr_price_change` | boolean | No | Include 24h price change % |

```typescript
async function getTokenPrices(addresses: string[]): Promise<Record<string, TokenPriceData>> {
  const addressList = addresses.join(',');
  const url = `${BASE_URL}/simple/networks/${NETWORK}/token_price/${addressList}`;

  const params = new URLSearchParams({
    include_market_cap: 'true',
    include_24hr_vol: 'true',
    include_24hr_price_change: 'true',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.attributes || {};
}
```

---

### Token Data by Address

Get detailed token information.

**Endpoint**: `GET /networks/{network}/tokens/{address}`

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | string | Yes | Network ID |
| `address` | string | Yes | Token contract address |
| `include` | string | No | Include `top_pools` for liquidity data |

```typescript
interface TokenData {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  image_url: string;
  price_usd: string;
  fdv_usd: string;
  market_cap_usd: string;
  total_supply: string;
  volume_usd: {
    h24: string;
  };
  price_change_percentage: {
    h24: string;
  };
}

async function getTokenData(address: string): Promise<TokenData> {
  const url = `${BASE_URL}/networks/${NETWORK}/tokens/${address}?include=top_pools`;

  const response = await fetch(url, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.attributes;
}
```

---

### Multi-Token Data

Batch fetch multiple tokens.

**Endpoint**: `GET /networks/{network}/tokens/multi/{addresses}`

```typescript
async function getMultipleTokens(addresses: string[]): Promise<TokenData[]> {
  const addressList = addresses.join(',');
  const url = `${BASE_URL}/networks/${NETWORK}/tokens/multi/${addressList}`;

  const response = await fetch(url, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}
```

---

### Pool Data by Address

Get detailed pool information.

**Endpoint**: `GET /networks/{network}/pools/{address}`

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include` | string | No | `base_token`, `quote_token`, `dex` |
| `include_volume_breakdown` | boolean | No | Volume breakdown by timeframe |

```typescript
interface PoolData {
  address: string;
  name: string;
  pool_created_at: string;
  base_token_price_usd: string;
  quote_token_price_usd: string;
  base_token_price_native_currency: string;
  fdv_usd: string;
  market_cap_usd: string;
  reserve_in_usd: string;
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

async function getPoolData(poolAddress: string): Promise<PoolData> {
  const url = `${BASE_URL}/networks/${NETWORK}/pools/${poolAddress}`;

  const params = new URLSearchParams({
    include: 'base_token,quote_token,dex',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.attributes;
}
```

---

### Trending Pools

Get trending pools across all networks or filtered by network.

**Endpoint**: `GET /networks/trending_pools`

**Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include` | string | `base_token` | Attributes to include |
| `page` | integer | 1 | Page number |
| `duration` | string | `24h` | `5m`, `1h`, `6h`, `24h` |

```typescript
async function getTrendingPools(duration: '5m' | '1h' | '6h' | '24h' = '24h'): Promise<PoolData[]> {
  const url = `${BASE_URL}/networks/trending_pools`;

  const params = new URLSearchParams({
    include: 'base_token,quote_token,dex,network',
    duration,
    page: '1',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}

// Filter for Solana pools
async function getSolanaTrendingPools(): Promise<PoolData[]> {
  const allPools = await getTrendingPools();
  return allPools.filter(pool => pool.network === 'solana');
}
```

---

### Top Pools on Network

Get top pools by volume on Solana.

**Endpoint**: `GET /networks/{network}/pools`

```typescript
async function getTopPools(page: number = 1): Promise<PoolData[]> {
  const url = `${BASE_URL}/networks/${NETWORK}/pools`;

  const params = new URLSearchParams({
    include: 'base_token,quote_token,dex',
    page: page.toString(),
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}
```

---

### Search Pools

Search for pools by token name, symbol, or address.

**Endpoint**: `GET /search/pools`

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search term (name, symbol, address) |
| `network` | string | Filter by network |
| `page` | integer | Page number |

```typescript
async function searchPools(query: string): Promise<PoolData[]> {
  const url = `${BASE_URL}/search/pools`;

  const params = new URLSearchParams({
    query,
    network: NETWORK,
    include: 'base_token,quote_token,dex',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}

// Search for SOL pools
const solPools = await searchPools('SOL');
```

---

### Pool OHLCV Chart

Get candlestick data for technical analysis.

**Endpoint**: `GET /networks/{network}/pools/{pool_address}/ohlcv/{timeframe}`

**Timeframes**: `day`, `hour`, `minute`

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `aggregate` | integer | Candle aggregation (1, 5, 15 for minute; 1, 4, 12 for hour) |
| `before_timestamp` | integer | Unix timestamp for pagination |
| `limit` | integer | Number of candles (max 1000) |
| `currency` | string | `usd` or `token` |

```typescript
interface OHLCVData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function getPoolOHLCV(
  poolAddress: string,
  timeframe: 'day' | 'hour' | 'minute' = 'hour',
  aggregate: number = 1,
  limit: number = 100
): Promise<OHLCVData[]> {
  const url = `${BASE_URL}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`;

  const params = new URLSearchParams({
    aggregate: aggregate.toString(),
    limit: limit.toString(),
    currency: 'usd',
  });

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();

  return data.data?.attributes?.ohlcv_list?.map((candle: number[]) => ({
    timestamp: candle[0],
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
  })) || [];
}

// Get hourly candles
const hourlyCandles = await getPoolOHLCV(poolAddress, 'hour', 1, 24);

// Get 5-minute candles
const fiveMinCandles = await getPoolOHLCV(poolAddress, 'minute', 5, 100);
```

---

### Recent Trades

Get recent trades for a pool.

**Endpoint**: `GET /networks/{network}/pools/{pool_address}/trades`

```typescript
interface TradeData {
  block_number: number;
  block_timestamp: string;
  tx_hash: string;
  tx_from_address: string;
  from_token_amount: string;
  to_token_amount: string;
  price_from_in_currency_token: string;
  price_to_in_currency_token: string;
  price_from_in_usd: string;
  price_to_in_usd: string;
  kind: 'buy' | 'sell';
  volume_in_usd: string;
}

async function getRecentTrades(poolAddress: string): Promise<TradeData[]> {
  const url = `${BASE_URL}/networks/${NETWORK}/pools/${poolAddress}/trades`;

  const response = await fetch(url, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}
```

---

### List DEXes on Solana

Get all decentralized exchanges on Solana.

**Endpoint**: `GET /networks/{network}/dexes`

```typescript
interface DexData {
  id: string;
  name: string;
}

async function getSolanaDexes(): Promise<DexData[]> {
  const url = `${BASE_URL}/networks/${NETWORK}/dexes`;

  const response = await fetch(url, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => ({
    id: item.id,
    name: item.attributes.name,
  })) || [];
}
```

---

### Megafilter (Advanced)

Advanced filtering for pools across networks, DEXes, and tokens.

**Endpoint**: `GET /pools/megafilter`

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `networks` | string | Filter by network(s) |
| `dexes` | string | Filter by DEX(es) |
| `sort` | string | Sort order (e.g., `pool_created_at_desc`) |
| `min_reserve_in_usd` | number | Minimum liquidity |
| `min_h24_volume_usd` | number | Minimum 24h volume |

```typescript
async function getMegafilterPools(options: {
  dexes?: string[];
  minLiquidity?: number;
  minVolume?: number;
  sort?: string;
}): Promise<PoolData[]> {
  const url = `${BASE_URL}/pools/megafilter`;

  const params = new URLSearchParams({
    networks: NETWORK,
    page: '1',
  });

  if (options.dexes) {
    params.set('dexes', options.dexes.join(','));
  }
  if (options.minLiquidity) {
    params.set('min_reserve_in_usd', options.minLiquidity.toString());
  }
  if (options.minVolume) {
    params.set('min_h24_volume_usd', options.minVolume.toString());
  }
  if (options.sort) {
    params.set('sort', options.sort);
  }

  const response = await fetch(`${url}?${params}`, {
    headers: { [HEADER_KEY]: apiKey },
  });

  const data = await response.json();
  return data.data?.map((item: any) => item.attributes) || [];
}

// Get newest Pump.fun pools
const pumpfunPools = await getMegafilterPools({
  dexes: ['pump-fun'],
  sort: 'pool_created_at_desc',
});

// Get high-volume Raydium pools
const raydiumPools = await getMegafilterPools({
  dexes: ['raydium'],
  minVolume: 100000,
  minLiquidity: 50000,
});
```

---

## Common Solana DEX Identifiers

| DEX | ID | Description |
|-----|-----|-------------|
| Raydium | `raydium` | Leading AMM on Solana |
| Orca | `orca` | User-friendly DEX |
| Jupiter | `jupiter` | Aggregator with pools |
| Meteora | `meteora` | Dynamic AMM |
| Pump.fun | `pump-fun` | Memecoin launchpad |
| OpenBook | `openbook` | Order book DEX |
| Lifinity | `lifinity` | Proactive market maker |
| Phoenix | `phoenix` | On-chain order book |

---

## Common Token Addresses

| Token | Address |
|-------|---------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |
| PYTH | `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` |
| RAY | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` |
| ORCA | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` |

---

## Rate Limits

| Plan | Calls/Minute | Max Addresses/Request |
|------|--------------|----------------------|
| Demo (Free) | 30 | 30 |
| Analyst | 500 | 50 |
| Lite | 500 | 50 |
| Pro | 1,000 | 100 |
| Enterprise | Custom | Custom |

### Rate Limit Handling

```typescript
class RateLimiter {
  private calls: number[] = [];
  private maxCalls: number;
  private windowMs: number = 60000; // 1 minute

  constructor(maxCallsPerMinute: number) {
    this.maxCalls = maxCallsPerMinute;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < this.windowMs);

    if (this.calls.length >= this.maxCalls) {
      const oldestCall = this.calls[0];
      const waitTime = this.windowMs - (now - oldestCall);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.calls.push(Date.now());
  }
}

// Usage
const rateLimiter = new RateLimiter(30); // Demo API

async function fetchWithRateLimit(url: string): Promise<any> {
  await rateLimiter.waitForSlot();
  const response = await fetch(url, {
    headers: { [HEADER_KEY]: apiKey },
  });
  return response.json();
}
```

---

## Error Handling

```typescript
async function safeApiCall<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { [HEADER_KEY]: apiKey },
    });

    if (response.status === 401) {
      throw new Error('Invalid API key');
    }
    if (response.status === 429) {
      throw new Error('Rate limit exceeded - wait before retrying');
    }
    if (response.status === 404) {
      console.warn('Resource not found');
      return null;
    }
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('CoinGecko API error:', error);
    throw error;
  }
}
```

### Common Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| 401 | Invalid API key | Check your API key |
| 429 | Rate limit exceeded | Wait and retry, or upgrade plan |
| 404 | Resource not found | Check address/network ID |
| 500+ | Server error | Retry with exponential backoff |

---

## Best Practices

### Security
- Never commit API keys to git
- Use environment variables
- Rotate keys periodically
- Use separate keys for dev/prod

### Performance
- Batch token requests when possible
- Cache frequently accessed data
- Use appropriate timeframes for OHLCV
- Implement request queuing for rate limits

### Data Quality
- Verify market cap data (may be null if unverified)
- Check pool liquidity before trusting prices
- Use multiple timeframes for price analysis
- Monitor last trade timestamp for activity

---

## Resources

- [CoinGecko API Documentation](https://docs.coingecko.com)
- [GeckoTerminal](https://www.geckoterminal.com)
- [CoinGecko API Pricing](https://www.coingecko.com/en/api/pricing)
- [API Changelog](https://docs.coingecko.com/changelog)

---

## Skill Structure

```
coingecko/
├── SKILL.md                      # This file
├── resources/
│   ├── api-reference.md          # Complete API endpoint reference
│   ├── network-dex-ids.md        # Solana network and DEX identifiers
│   └── token-addresses.md        # Common Solana token addresses
├── examples/
│   ├── token-prices/
│   │   └── get-token-price.ts    # Token price examples
│   ├── pools/
│   │   └── pool-data.ts          # Pool data examples
│   ├── ohlcv/
│   │   └── ohlcv-charts.ts       # OHLCV chart examples
│   ├── trades/
│   │   └── recent-trades.ts      # Trade history examples
│   └── integration/
│       └── full-client.ts        # Complete client example
├── templates/
│   └── coingecko-client.ts       # Production-ready client template
└── docs/
    └── troubleshooting.md        # Common issues and solutions
```
