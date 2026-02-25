# DFlow Prediction Market Metadata API Reference

Complete reference for the DFlow Prediction Market Metadata API.

## Base URL

```
https://api.prod.dflow.net
```

## Authentication

Include API key in the `x-api-key` header:
```typescript
const headers = {
  "x-api-key": "your-api-key",
  "content-type": "application/json"
};
```

Contact `hello@dflow.net` to obtain an API key.

---

## Events API

### GET /api/v1/event/{ticker}

Returns a single event by its ticker. Can optionally include nested markets.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Event ticker (e.g., "TRUMP-2024") |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_markets` | boolean | No | Include nested markets in response |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024",
  "title": "Will Trump win the 2024 election?",
  "description": "Resolves YES if Trump wins...",
  "status": "active",
  "series_ticker": "US-ELECTIONS",
  "category": "politics",
  "close_time": "2024-11-05T00:00:00Z",
  "markets": [
    {
      "ticker": "TRUMP-2024-WIN",
      "yes_mint": "...",
      "no_mint": "...",
      "last_price": 0.52,
      "volume_24h": 1500000
    }
  ]
}
```

---

### GET /api/v1/events

Returns a paginated list of all events.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Max results per page (default: 50) |
| `offset` | integer | No | Pagination offset (default: 0) |
| `status` | string | No | Filter by status: active, closed, determined, finalized |
| `category` | string | No | Filter by category |
| `series_ticker` | string | No | Filter by series |

**Response (200):**

```json
{
  "events": [
    {
      "ticker": "TRUMP-2024",
      "title": "Will Trump win the 2024 election?",
      "status": "active",
      "close_time": "2024-11-05T00:00:00Z"
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

---

### GET /api/v1/event/{ticker}/forecast

Returns historical forecast percentile data for an event.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Event ticker |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start_time` | timestamp | No | Start of time range |
| `end_time` | timestamp | No | End of time range |
| `interval` | string | No | Data interval: 1h, 4h, 1d |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024",
  "forecasts": [
    {
      "timestamp": "2024-10-01T00:00:00Z",
      "probability": 0.48,
      "volume": 250000
    }
  ]
}
```

---

### GET /api/v1/event/{ticker}/candlesticks

Returns candlestick data from Kalshi.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Event ticker |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `interval` | string | No | Candlestick interval: 1m, 5m, 15m, 1h, 4h, 1d |
| `start_time` | timestamp | No | Start timestamp |
| `end_time` | timestamp | No | End timestamp |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024",
  "interval": "1h",
  "candlesticks": [
    {
      "timestamp": "2024-10-01T12:00:00Z",
      "open": 0.48,
      "high": 0.52,
      "low": 0.47,
      "close": 0.51,
      "volume": 75000
    }
  ]
}
```

---

## Markets API

### GET /api/v1/market/{ticker}

Returns a single market by its ticker.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Market ticker (e.g., "TRUMP-2024-WIN") |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024-WIN",
  "event_ticker": "TRUMP-2024",
  "title": "Trump wins 2024 election",
  "yes_mint": "YeS1234...abcd",
  "no_mint": "No5678...efgh",
  "ledger_mint": "Ledger9012...ijkl",
  "status": "active",
  "last_price": 0.52,
  "yes_price": 0.52,
  "no_price": 0.48,
  "volume_24h": 1500000,
  "open_interest": 5000000,
  "created_at": "2024-01-01T00:00:00Z"
}
```

---

### GET /api/v1/market/by-mint/{mint_address}

Looks up any mint address (ledger or outcome mints) to retrieve market data.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mint_address` | string | Yes | Base58 mint address |

**Response (200):**

Same as GET /api/v1/market/{ticker}

---

### GET /api/v1/markets

Returns a paginated list of all markets.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Max results (default: 50) |
| `offset` | integer | No | Pagination offset |
| `status` | string | No | Filter by market status |
| `event_ticker` | string | No | Filter by parent event |

**Response (200):**

```json
{
  "markets": [...],
  "total": 500,
  "limit": 50,
  "offset": 0
}
```

---

### POST /api/v1/markets/batch

Accepts multiple tickers and/or mint addresses. Capped at 100 markets maximum.

**Request Body:**

```json
{
  "tickers": ["TRUMP-2024-WIN", "HARRIS-2024-WIN"],
  "mints": ["YeS1234...abcd", "No5678...efgh"]
}
```

**Response (200):**

```json
{
  "markets": [
    {
      "ticker": "TRUMP-2024-WIN",
      "yes_mint": "...",
      "no_mint": "...",
      "last_price": 0.52
    }
  ],
  "not_found": ["INVALID-TICKER"]
}
```

---

### GET /api/v1/outcome_mints

Returns a flat list of all yes_mint and no_mint pubkeys from all supported markets.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `min_close_timestamp` | integer | No | Only mints for markets closing after this timestamp |

**Response (200):**

```json
{
  "outcome_mints": [
    {
      "mint": "YeS1234...abcd",
      "market_ticker": "TRUMP-2024-WIN",
      "outcome": "yes"
    },
    {
      "mint": "No5678...efgh",
      "market_ticker": "TRUMP-2024-WIN",
      "outcome": "no"
    }
  ]
}
```

---

### POST /api/v1/filter_outcome_mints

Accepts up to 200 token addresses and returns only those that are outcome mints.

**Request Body:**

```json
{
  "addresses": [
    "YeS1234...abcd",
    "No5678...efgh",
    "RandomToken123...",
    "USDC..."
  ]
}
```

**Response (200):**

```json
{
  "outcome_mints": [
    {
      "mint": "YeS1234...abcd",
      "market_ticker": "TRUMP-2024-WIN",
      "outcome": "yes"
    },
    {
      "mint": "No5678...efgh",
      "market_ticker": "TRUMP-2024-WIN",
      "outcome": "no"
    }
  ],
  "non_outcome_mints": [
    "RandomToken123...",
    "USDC..."
  ]
}
```

---

### GET /api/v1/market/{ticker}/candlesticks

Retrieves candlestick data for a market. Automatically resolves series ticker.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Market ticker |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `interval` | string | No | 1m, 5m, 15m, 1h, 4h, 1d |
| `start_time` | timestamp | No | Start of range |
| `end_time` | timestamp | No | End of range |

---

### GET /api/v1/market/by-mint/{mint_address}/candlesticks

Fetches candlestick data using mint address lookup.

---

## Orderbook API

### GET /api/v1/orderbook/{ticker}

Retrieve orderbook data by market ticker.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Market ticker |

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `depth` | integer | No | Number of levels (default: 10) |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024-WIN",
  "timestamp": "2024-10-01T12:00:00Z",
  "bids": [
    { "price": 0.51, "quantity": 10000 },
    { "price": 0.50, "quantity": 25000 },
    { "price": 0.49, "quantity": 50000 }
  ],
  "asks": [
    { "price": 0.52, "quantity": 15000 },
    { "price": 0.53, "quantity": 30000 },
    { "price": 0.54, "quantity": 45000 }
  ],
  "spread": 0.01,
  "mid_price": 0.515
}
```

---

### GET /api/v1/orderbook/by-mint/{mint_address}

Retrieve orderbook using mint address lookup.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mint_address` | string | Yes | Base58 outcome mint address |

---

## Trades API

### GET /api/v1/trades

Returns a paginated list of all trades. Can be filtered by market ticker and timestamp range. Relays requests directly to Kalshi API.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | No | Filter by market ticker |
| `limit` | integer | No | Max results (default: 100) |
| `offset` | integer | No | Pagination offset |
| `start_time` | timestamp | No | Start of time range |
| `end_time` | timestamp | No | End of time range |
| `side` | string | No | Filter by side: buy, sell |

**Response (200):**

```json
{
  "trades": [
    {
      "id": "trade-uuid-123",
      "ticker": "TRUMP-2024-WIN",
      "price": 0.52,
      "quantity": 1000,
      "side": "buy",
      "outcome": "yes",
      "timestamp": "2024-10-01T12:30:45Z",
      "taker_address": "Taker123...",
      "maker_address": "Maker456..."
    }
  ],
  "total": 5000,
  "limit": 100,
  "offset": 0
}
```

---

### GET /api/v1/trades/by-mint/{mint_address}

Looks up the market ticker from a mint address, then fetches trades from Kalshi.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mint_address` | string | Yes | Base58 outcome mint address |

**Query Parameters:**

Same as GET /api/v1/trades

---

## Live Data API

### GET /api/v1/milestones/{ticker}

Real-time milestone data from Kalshi.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ticker` | string | Yes | Event ticker |

**Response (200):**

```json
{
  "ticker": "TRUMP-2024",
  "milestones": [
    {
      "name": "Primary Results",
      "timestamp": "2024-03-05T00:00:00Z",
      "probability_before": 0.45,
      "probability_after": 0.52,
      "volume_spike": 500000
    }
  ]
}
```

---

### GET /api/v1/milestones/by-mint/{mint_address}

Fetch milestones using mint address lookup.

---

### POST /api/v1/milestones/batch

Batch retrieve milestones for multiple events.

**Request Body:**

```json
{
  "tickers": ["TRUMP-2024", "HARRIS-2024"]
}
```

---

## Series & Categories API

### GET /api/v1/series

Returns series templates for recurring events.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | string | No | Filter by category |

**Response (200):**

```json
{
  "series": [
    {
      "ticker": "US-ELECTIONS",
      "title": "US Presidential Elections",
      "category": "politics",
      "events_count": 5
    }
  ]
}
```

---

### GET /api/v1/categories

Returns all category tags.

**Response (200):**

```json
{
  "categories": [
    {
      "id": "politics",
      "name": "Politics",
      "events_count": 50
    },
    {
      "id": "sports",
      "name": "Sports",
      "events_count": 120
    },
    {
      "id": "crypto",
      "name": "Crypto",
      "events_count": 35
    }
  ]
}
```

---

### GET /api/v1/sports

Returns sports filtering options.

**Response (200):**

```json
{
  "sports": [
    { "id": "nfl", "name": "NFL" },
    { "id": "nba", "name": "NBA" },
    { "id": "mlb", "name": "MLB" }
  ]
}
```

---

## Search API

### GET /api/v1/search

Search for events and markets.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query |
| `type` | string | No | Filter: event, market, all |
| `limit` | integer | No | Max results (default: 20) |

**Response (200):**

```json
{
  "results": [
    {
      "type": "event",
      "ticker": "TRUMP-2024",
      "title": "Will Trump win the 2024 election?",
      "relevance_score": 0.95
    },
    {
      "type": "market",
      "ticker": "TRUMP-2024-WIN",
      "title": "Trump wins",
      "relevance_score": 0.92
    }
  ]
}
```

---

## WebSocket API

### Connection

```
wss://api.prod.dflow.net/ws
```

### Subscription Messages

**Subscribe to market:**
```json
{
  "action": "subscribe",
  "channel": "market",
  "ticker": "TRUMP-2024-WIN"
}
```

**Subscribe to orderbook:**
```json
{
  "action": "subscribe",
  "channel": "orderbook",
  "ticker": "TRUMP-2024-WIN"
}
```

**Subscribe to trades:**
```json
{
  "action": "subscribe",
  "channel": "trades",
  "ticker": "TRUMP-2024-WIN"
}
```

**Unsubscribe:**
```json
{
  "action": "unsubscribe",
  "channel": "market",
  "ticker": "TRUMP-2024-WIN"
}
```

### Message Types

**Price Update:**
```json
{
  "type": "price_update",
  "ticker": "TRUMP-2024-WIN",
  "yes_price": 0.52,
  "no_price": 0.48,
  "timestamp": "2024-10-01T12:00:00Z"
}
```

**Orderbook Update:**
```json
{
  "type": "orderbook_update",
  "ticker": "TRUMP-2024-WIN",
  "bids": [...],
  "asks": [...],
  "timestamp": "2024-10-01T12:00:00Z"
}
```

**Trade:**
```json
{
  "type": "trade",
  "ticker": "TRUMP-2024-WIN",
  "price": 0.52,
  "quantity": 1000,
  "side": "buy",
  "timestamp": "2024-10-01T12:00:00Z"
}
```

---

## HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad request - invalid parameters |
| 401 | Unauthorized - invalid/missing API key |
| 404 | Not found - event/market doesn't exist |
| 429 | Rate limited |
| 500 | Internal server error |
| 503 | Service unavailable |

---

## Rate Limits

- Without API key: ~10 requests/minute
- With API key: Higher limits (contact DFlow for specifics)

Production applications should always use an API key.

---

## Kalshi Integration Notes

Several endpoints relay data from Kalshi's API:
- Candlestick data
- Trade history
- Milestones
- Forecast percentiles

These endpoints automatically resolve DFlow market tickers to Kalshi market identifiers.
