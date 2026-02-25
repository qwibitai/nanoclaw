# CoinGecko Onchain API Reference

Complete API endpoint reference for CoinGecko's Solana on-chain data API.

## Base URLs

| API Tier | Base URL |
|----------|----------|
| Demo | `https://api.coingecko.com/api/v3/onchain` |
| Pro | `https://pro-api.coingecko.com/api/v3/onchain` |

## Authentication Headers

| API Tier | Header Name |
|----------|-------------|
| Demo | `x-cg-demo-api-key` |
| Pro | `x-cg-pro-api-key` |

---

## Simple Price Endpoints

### Get Token Price by Address

**Endpoint**: `GET /simple/networks/{network}/token_price/{addresses}`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `network` | path | Yes | - | Network ID (e.g., `solana`) |
| `addresses` | path | Yes | - | Comma-separated token addresses |
| `include_market_cap` | query | No | false | Include market cap data |
| `mcap_fdv_fallback` | query | No | false | Return FDV when market cap unavailable |
| `include_24hr_vol` | query | No | false | Include 24h trading volume |
| `include_24hr_price_change` | query | No | false | Include 24h price change % |
| `include_total_reserve_in_usd` | query | No | false | Include total reserve in USD |

**Response Schema**:
```json
{
  "data": {
    "id": "string",
    "type": "simple_token_price",
    "attributes": {
      "token_prices": {
        "<address>": "<price_usd>"
      },
      "market_cap_usd": {
        "<address>": "<market_cap>"
      },
      "h24_volume_usd": {
        "<address>": "<volume>"
      },
      "h24_price_change_percentage": {
        "<address>": "<percentage>"
      },
      "total_reserve_in_usd": {
        "<address>": "<reserve>"
      },
      "last_trade_timestamp": {
        "<address>": <unix_timestamp>
      }
    }
  }
}
```

---

## Token Endpoints

### Get Token Data by Address

**Endpoint**: `GET /networks/{network}/tokens/{address}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `address` | path | Yes | Token contract address |
| `include` | query | No | Include `top_pools` for liquidity data |
| `include_composition` | query | No | Include pool token balances |
| `include_inactive_source` | query | No | Include data from inactive pools |

**Response Schema**:
```json
{
  "data": {
    "id": "string",
    "type": "token",
    "attributes": {
      "address": "string",
      "name": "string",
      "symbol": "string",
      "decimals": number,
      "image_url": "string",
      "websites": ["string"],
      "description": "string",
      "gt_score": number,
      "discord_url": "string",
      "telegram_handle": "string",
      "twitter_handle": "string",
      "coingecko_coin_id": "string",
      "price_usd": "string",
      "fdv_usd": "string",
      "market_cap_usd": "string",
      "total_supply": "string",
      "volume_usd": {
        "h24": "string"
      },
      "price_change_percentage": {
        "h1": "string",
        "h6": "string",
        "h24": "string"
      }
    },
    "relationships": {
      "top_pools": {
        "data": [{ "id": "string", "type": "pool" }]
      }
    }
  }
}
```

### Get Multiple Tokens

**Endpoint**: `GET /networks/{network}/tokens/multi/{addresses}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `addresses` | path | Yes | Comma-separated addresses (max 30 Demo, 50 Pro) |
| `include` | query | No | Include `top_pools` |

---

## Pool Endpoints

### Get Pool by Address

**Endpoint**: `GET /networks/{network}/pools/{address}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `address` | path | Yes | Pool contract address |
| `include` | query | No | `base_token`, `quote_token`, `dex` |
| `include_volume_breakdown` | query | No | Volume breakdown details |
| `include_composition` | query | No | Pool composition data |

**Response Schema**:
```json
{
  "data": {
    "id": "string",
    "type": "pool",
    "attributes": {
      "address": "string",
      "name": "string",
      "pool_created_at": "string",
      "fdv_usd": "string",
      "market_cap_usd": "string",
      "reserve_in_usd": "string",
      "base_token_price_usd": "string",
      "quote_token_price_usd": "string",
      "base_token_price_native_currency": "string",
      "price_change_percentage": {
        "m5": "string",
        "h1": "string",
        "h6": "string",
        "h24": "string"
      },
      "transactions": {
        "m5": { "buys": number, "sells": number, "buyers": number, "sellers": number },
        "m15": { "buys": number, "sells": number, "buyers": number, "sellers": number },
        "m30": { "buys": number, "sells": number, "buyers": number, "sellers": number },
        "h1": { "buys": number, "sells": number, "buyers": number, "sellers": number },
        "h24": { "buys": number, "sells": number, "buyers": number, "sellers": number }
      },
      "volume_usd": {
        "m5": "string",
        "h1": "string",
        "h6": "string",
        "h24": "string"
      }
    }
  }
}
```

### Get Top Pools on Network

**Endpoint**: `GET /networks/{network}/pools`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `network` | path | Yes | - | Network ID |
| `include` | query | No | - | `base_token`, `quote_token`, `dex` |
| `page` | query | No | 1 | Page number |
| `sort` | query | No | - | Sort field |

### Get Trending Pools

**Endpoint**: `GET /networks/trending_pools`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `include` | query | No | `base_token` | Attributes to include |
| `page` | query | No | 1 | Page number (max 10 for Demo) |
| `duration` | query | No | `24h` | `5m`, `1h`, `6h`, `24h` |
| `include_gt_community_data` | query | No | false | Include sentiment data |

### Get Trending Pools by Network

**Endpoint**: `GET /networks/{network}/trending_pools`

Same parameters as above, filtered to specific network.

### Get New Pools

**Endpoint**: `GET /networks/{network}/new_pools`

Returns recently created pools on the network.

### Search Pools

**Endpoint**: `GET /search/pools`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | query | No | `weth` | Search term |
| `network` | query | No | - | Filter by network |
| `include` | query | No | `base_token` | Attributes to include |
| `page` | query | No | 1 | Page number |

### Multi-Pool Data

**Endpoint**: `GET /networks/{network}/pools/multi/{addresses}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `addresses` | path | Yes | Comma-separated pool addresses |
| `include` | query | No | Attributes to include |

### Megafilter Pools

**Endpoint**: `GET /pools/megafilter`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `networks` | query | No | Filter by network(s) |
| `dexes` | query | No | Filter by DEX(es) |
| `sort` | query | No | Sort order |
| `min_reserve_in_usd` | query | No | Minimum liquidity |
| `max_reserve_in_usd` | query | No | Maximum liquidity |
| `min_h24_volume_usd` | query | No | Minimum 24h volume |
| `max_h24_volume_usd` | query | No | Maximum 24h volume |
| `min_h24_tx_count` | query | No | Minimum 24h transactions |
| `page` | query | No | Page number |

---

## OHLCV Endpoints

### Get Pool OHLCV

**Endpoint**: `GET /networks/{network}/pools/{pool_address}/ohlcv/{timeframe}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `pool_address` | path | Yes | Pool address |
| `timeframe` | path | Yes | `day`, `hour`, `minute` |
| `aggregate` | query | No | Candle aggregation |
| `before_timestamp` | query | No | Unix timestamp for pagination |
| `limit` | query | No | Number of candles (max 1000) |
| `currency` | query | No | `usd` or `token` |

**Aggregation Values**:
- `minute`: 1, 5, 15
- `hour`: 1, 4, 12
- `day`: 1

**Response Schema**:
```json
{
  "data": {
    "id": "string",
    "type": "ohlcv",
    "attributes": {
      "ohlcv_list": [
        [timestamp, open, high, low, close, volume]
      ]
    }
  }
}
```

### Get Token OHLCV

**Endpoint**: `GET /networks/{network}/tokens/{token_address}/ohlcv/{timeframe}`

Same parameters as pool OHLCV, but for token address.

---

## Trade Endpoints

### Get Pool Trades

**Endpoint**: `GET /networks/{network}/pools/{pool_address}/trades`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `pool_address` | path | Yes | Pool address |
| `trade_volume_in_usd_greater_than` | query | No | Minimum trade volume |

Returns last 300 trades in past 24 hours.

**Response Schema**:
```json
{
  "data": [
    {
      "id": "string",
      "type": "trade",
      "attributes": {
        "block_number": number,
        "block_timestamp": "string",
        "tx_hash": "string",
        "tx_from_address": "string",
        "from_token_amount": "string",
        "to_token_amount": "string",
        "price_from_in_currency_token": "string",
        "price_to_in_currency_token": "string",
        "price_from_in_usd": "string",
        "price_to_in_usd": "string",
        "kind": "buy" | "sell",
        "volume_in_usd": "string"
      }
    }
  ]
}
```

---

## Network & DEX Endpoints

### List Networks

**Endpoint**: `GET /networks`

Returns all supported blockchain networks.

### List DEXes on Network

**Endpoint**: `GET /networks/{network}/dexes`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | path | Yes | Network ID |
| `page` | query | No | Page number |

**Response Schema**:
```json
{
  "data": [
    {
      "id": "string",
      "type": "dex",
      "attributes": {
        "name": "string"
      }
    }
  ]
}
```

---

## Update Frequencies

| Endpoint Type | Update Frequency |
|---------------|------------------|
| Token prices | 10 seconds |
| Pool data | 10 seconds |
| Trending pools | 30 seconds |
| OHLCV | Real-time |
| Trades | Real-time |
| DEX list | Daily |

---

## Pagination

Most list endpoints support pagination:

| Parameter | Description |
|-----------|-------------|
| `page` | Page number (1-indexed) |

- Demo API: Max 10 pages
- Pro API: Unlimited pages

Results per page: 20 items (pools, tokens, etc.)
