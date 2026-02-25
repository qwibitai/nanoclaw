# CoinGecko API Troubleshooting Guide

Common issues and solutions when working with the CoinGecko Solana API.

## Authentication Errors

### Error: 401 Unauthorized

**Cause**: Invalid or missing API key.

**Solutions**:

1. Verify your API key is correct:
```typescript
// Check environment variable
console.log('API Key set:', !!process.env.COINGECKO_API_KEY);
```

2. Ensure you're using the correct header:
```typescript
// Demo API
headers: { 'x-cg-demo-api-key': apiKey }

// Pro API
headers: { 'x-cg-pro-api-key': apiKey }
```

3. Verify API type matches your key:
```typescript
// Demo keys work with: api.coingecko.com
// Pro keys work with: pro-api.coingecko.com
```

---

## Rate Limiting

### Error: 429 Too Many Requests

**Cause**: Exceeded rate limit (30/min Demo, 500-1000/min Pro).

**Solutions**:

1. Implement rate limiting:
```typescript
class RateLimiter {
  private calls: number[] = [];
  private maxCalls: number;

  constructor(maxCallsPerMinute: number) {
    this.maxCalls = maxCallsPerMinute;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < 60000);

    if (this.calls.length >= this.maxCalls) {
      const waitTime = 60000 - (now - this.calls[0]);
      await new Promise(r => setTimeout(r, waitTime + 100));
    }

    this.calls.push(Date.now());
  }
}
```

2. Batch requests when possible:
```typescript
// Instead of multiple single requests
const price1 = await getPrice(addr1);
const price2 = await getPrice(addr2);

// Use batch endpoint
const prices = await getPrices([addr1, addr2]);
```

3. Cache frequently accessed data:
```typescript
const cache = new Map<string, { data: any; expiry: number }>();

async function getCachedData(key: string, fetchFn: () => Promise<any>, ttlMs: number = 30000) {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  const data = await fetchFn();
  cache.set(key, { data, expiry: Date.now() + ttlMs });
  return data;
}
```

---

## Data Issues

### Issue: Token/Pool Not Found (404)

**Possible Causes**:
- Token not indexed yet (new tokens may take time)
- Incorrect address format
- Token/pool has no liquidity

**Solutions**:

1. Verify address format:
```typescript
// Solana addresses are base58 encoded, 32-44 characters
function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}
```

2. Search for the token/pool:
```typescript
// If direct lookup fails, try searching
const results = await searchPools(tokenSymbol);
```

3. Check if pool has sufficient liquidity (very low liquidity pools may not be indexed).

### Issue: Market Cap Returns Null

**Cause**: Market cap not verified by CoinGecko team.

**Solution**: Use FDV (Fully Diluted Valuation) as fallback:
```typescript
const marketCap = data.market_cap_usd ?? data.fdv_usd;

// Or use the API parameter
const response = await fetch(url + '?mcap_fdv_fallback=true');
```

### Issue: Price is 0 or Null

**Possible Causes**:
- No recent trades
- Inactive pool
- Token not traded on indexed DEXes

**Solution**: Check last trade timestamp:
```typescript
const priceData = await getTokenPrice(address);

if (priceData.lastTradeTimestamp) {
  const lastTradeAge = Date.now() / 1000 - priceData.lastTradeTimestamp;
  if (lastTradeAge > 3600) {
    console.warn('Price may be stale - last trade was', lastTradeAge / 3600, 'hours ago');
  }
}
```

---

## Network Errors

### Error: ECONNREFUSED / Network Error

**Solutions**:

1. Implement retry logic:
```typescript
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
      }
    }
  }

  throw lastError;
}
```

2. Add timeout to requests:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10000);

try {
  const response = await fetch(url, { signal: controller.signal });
  return response.json();
} finally {
  clearTimeout(timeout);
}
```

---

## OHLCV Issues

### Issue: Missing or Incomplete Candle Data

**Possible Causes**:
- Pool is new (not enough history)
- Low trading activity during period
- Requested timeframe too granular for pool activity

**Solutions**:

1. Use larger timeframes for low-activity pools:
```typescript
// Instead of 1-minute candles
const candles = await getOHLCV(pool, 'minute', 1);

// Try hourly
const candles = await getOHLCV(pool, 'hour', 1);
```

2. Check pool age before requesting historical data:
```typescript
const pool = await getPoolInfo(address);
const poolAge = Date.now() - pool.createdAt.getTime();
const hoursOld = poolAge / 3600000;

const limit = Math.min(hoursOld, 100); // Don't request more candles than pool age
```

### Issue: OHLCV Volume Doesn't Match Pool Volume

**Cause**: OHLCV volume is aggregated per candle, pool volume is rolling 24h.

**Solution**: Sum candle volumes for comparison:
```typescript
const hourlyCandles = await getOHLCV(pool, 'hour', 1, 24);
const summedVolume = hourlyCandles.reduce((sum, c) => sum + c.volume, 0);
// This should approximately match pool.volume24h
```

---

## Common Mistakes

### Using Wrong Network ID

```typescript
// Wrong
const url = `/networks/sol/pools/...`;

// Correct
const url = `/networks/solana/pools/...`;
```

### Not URL-Encoding Addresses

```typescript
// Some addresses may need encoding if they contain special characters
const encodedAddress = encodeURIComponent(address);
```

### Mixing Demo and Pro URLs

```typescript
// Demo API - use api.coingecko.com
const demoUrl = 'https://api.coingecko.com/api/v3/onchain/...';

// Pro API - use pro-api.coingecko.com
const proUrl = 'https://pro-api.coingecko.com/api/v3/onchain/...';
```

### Incorrect Decimal Handling

```typescript
// Token amounts are returned as strings to preserve precision
const amount = data.from_token_amount; // "1000000000"

// Convert with correct decimals
const decimals = 6; // USDC
const humanAmount = parseFloat(amount) / Math.pow(10, decimals);
```

---

## Debugging Tips

### Enable Request Logging

```typescript
async function fetchWithLogging(url: string, options: RequestInit) {
  console.log('Request:', url);
  const start = Date.now();

  const response = await fetch(url, options);

  console.log('Response:', response.status, `(${Date.now() - start}ms)`);
  return response;
}
```

### Validate API Response Structure

```typescript
function validateTokenPrice(data: any): data is TokenPriceResponse {
  return (
    data?.data?.attributes?.token_prices !== undefined
  );
}

const data = await fetch(url).then(r => r.json());
if (!validateTokenPrice(data)) {
  console.error('Unexpected response structure:', JSON.stringify(data, null, 2));
}
```

---

## Getting Help

- **API Documentation**: [docs.coingecko.com](https://docs.coingecko.com)
- **Status Page**: [status.coingecko.com](https://status.coingecko.com)
- **Support**: Contact via CoinGecko website for API-specific issues
