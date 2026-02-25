# Ranger Finance API Endpoints Reference

Complete reference for the Ranger SOR API endpoints.

## Base URLs

- **SOR API**: `https://api.ranger.finance/v1`
- **Data API**: `https://data.ranger.finance/v1`

## Authentication

All requests require an API key in the Authorization header:

```
Authorization: Bearer YOUR_API_KEY
```

## SOR API Endpoints

### Get Order Metadata (Quote)

Get pricing and routing information for a potential trade.

**Endpoint**: `POST /order_metadata`

**Request Body**:
```json
{
  "fee_payer": "WALLET_PUBLIC_KEY",
  "symbol": "SOL",
  "side": "Long",
  "size": 1.0,
  "collateral": 10.0,
  "size_denomination": "SOL",
  "collateral_denomination": "USDC",
  "adjustment_type": "Quote"
}
```

**Response**:
```json
{
  "venues": [
    {
      "venue_name": "DRIFT",
      "collateral": 10.0,
      "size": 1.0,
      "quote": {
        "base": 150.50,
        "fee": 0.15,
        "total": 150.65,
        "fee_breakdown": {
          "base_fee": 0.05,
          "spread_fee": 0.03,
          "volatility_fee": 0.02,
          "margin_fee": 0.03,
          "close_fee": 0.02,
          "other_fees": 0.00
        }
      },
      "order_available_liquidity": 100000,
      "venue_available_liquidity": 5000000
    }
  ],
  "total_collateral": 10.0,
  "total_size": 1.0
}
```

---

### Increase Position

Open a new position or add to an existing one.

**Endpoint**: `POST /increase_position`

**Request Body**:
```json
{
  "fee_payer": "WALLET_PUBLIC_KEY",
  "symbol": "SOL",
  "side": "Long",
  "size": 1.0,
  "collateral": 10.0,
  "size_denomination": "SOL",
  "collateral_denomination": "USDC",
  "adjustment_type": "Increase"
}
```

**Response**:
```json
{
  "message": "BASE64_ENCODED_TRANSACTION",
  "meta": {
    "executed_price": 150.50,
    "executed_size": 1.0,
    "executed_collateral": 10.0,
    "venues_used": ["DRIFT"]
  }
}
```

---

### Decrease Position

Reduce an existing position.

**Endpoint**: `POST /decrease_position`

**Request Body**:
```json
{
  "fee_payer": "WALLET_PUBLIC_KEY",
  "symbol": "SOL",
  "side": "Long",
  "size": 0.5,
  "collateral": 5.0,
  "size_denomination": "SOL",
  "collateral_denomination": "USDC",
  "adjustment_type": "DecreaseFlash"
}
```

**Valid adjustment_type values**:
- `DecreaseFlash`
- `DecreaseJupiter`
- `DecreaseDrift`
- `DecreaseAdrena`

**Response**: Same as Increase Position

---

### Close Position

Close an entire position.

**Endpoint**: `POST /close_position`

**Request Body**:
```json
{
  "fee_payer": "WALLET_PUBLIC_KEY",
  "symbol": "SOL",
  "side": "Long",
  "adjustment_type": "CloseAll"
}
```

**Valid adjustment_type values**:
- `CloseFlash`
- `CloseJupiter`
- `CloseDrift`
- `CloseAdrena`
- `CloseAll`

**Response**: Same as Increase Position

---

## Data API Endpoints

### Get Positions

Fetch positions for a wallet.

**Endpoint**: `GET /positions`

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `public_key` | string | Wallet address (required) |
| `platforms` | string[] | Filter by platforms |
| `symbols` | string[] | Filter by symbols |
| `start_date` | string | Filter by date range start |
| `end_date` | string | Filter by date range end |

**Example Request**:
```
GET /positions?public_key=ABC123&platforms=DRIFT,FLASH&symbols=SOL-PERP
```

**Response**:
```json
{
  "positions": [
    {
      "id": "pos_123",
      "symbol": "SOL-PERP",
      "side": "Long",
      "quantity": 1.5,
      "entry_price": 150.00,
      "liquidation_price": 120.00,
      "position_leverage": 10.0,
      "real_collateral": 15.0,
      "unrealized_pnl": 5.25,
      "borrow_fee": 0.01,
      "funding_fee": -0.05,
      "open_fee": 0.15,
      "close_fee": 0.15,
      "created_at": "2024-01-15T10:30:00Z",
      "opened_at": "2024-01-15T10:30:00Z",
      "platform": "DRIFT"
    }
  ]
}
```

---

## cURL Examples

### Get Quote

```bash
curl -X POST "https://api.ranger.finance/v1/order_metadata" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fee_payer": "YOUR_WALLET_ADDRESS",
    "symbol": "SOL",
    "side": "Long",
    "size": 1.0,
    "collateral": 10.0,
    "size_denomination": "SOL",
    "collateral_denomination": "USDC",
    "adjustment_type": "Quote"
  }'
```

### Open Position

```bash
curl -X POST "https://api.ranger.finance/v1/increase_position" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fee_payer": "YOUR_WALLET_ADDRESS",
    "symbol": "SOL",
    "side": "Long",
    "size": 1.0,
    "collateral": 10.0,
    "size_denomination": "SOL",
    "collateral_denomination": "USDC",
    "adjustment_type": "Increase"
  }'
```

### Get Positions

```bash
curl -X GET "https://api.ranger.finance/v1/positions?public_key=YOUR_WALLET_ADDRESS" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Close Position

```bash
curl -X POST "https://api.ranger.finance/v1/close_position" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fee_payer": "YOUR_WALLET_ADDRESS",
    "symbol": "SOL",
    "side": "Long",
    "adjustment_type": "CloseAll"
  }'
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "message": "Insufficient collateral for position",
  "error_code": 1001
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| 1001 | Insufficient collateral |
| 1002 | Position not found |
| 1003 | Invalid symbol |
| 1004 | Insufficient liquidity |
| 1005 | Rate limit exceeded |
| 2001 | Invalid API key |
| 2002 | Unauthorized |
| 3001 | Internal server error |

---

## Rate Limits

- **Standard**: 100 requests per minute
- **Position queries**: 30 requests per minute
- **Trade execution**: 10 requests per minute

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704067200
```
