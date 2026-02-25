# Lulo API Reference

Complete API documentation for integrating with Lulo's lending aggregator.

## Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://api.lulo.fi` |
| Staging | `https://staging.lulo.fi` |
| Developer Portal | `https://dev.lulo.fi` |

## Authentication

All API requests require a valid API key in the `x-api-key` header.

```typescript
const headers = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.LULO_API_KEY,
};
```

Get your API key from [dev.lulo.fi](https://dev.lulo.fi).

---

## Transaction Generation

### Generate Deposit Instructions

Creates serialized transactions for depositing tokens into Lulo.

**Endpoint**: `POST /v1/generate.transactions.deposit`

**Query Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `priorityFee` | number | No | Priority fee in microlamports (default: 50000) |

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner` | string | Yes | Wallet public key |
| `mintAddress` | string | Yes | Token mint address |
| `depositType` | string | Yes | `protected`, `boosted`, or `regular` |
| `amount` | number | Yes | Amount in token's smallest unit |
| `protectedAmount` | number | No | Amount for protected deposit |
| `regularAmount` | number | No | Amount for regular (custom) deposit |

**Example Request**:

```bash
curl -X POST "https://api.lulo.fi/v1/generate.transactions.deposit?priorityFee=500000" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "YourWalletPublicKey",
    "mintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "depositType": "protected",
    "amount": 100000000
  }'
```

**Response**:

```json
{
  "transaction": "base64EncodedSerializedTransaction",
  "lastValidBlockHeight": 123456789,
  "blockhash": "AbC123..."
}
```

---

### Generate Withdrawal Instructions

Creates serialized transactions for withdrawing tokens from Lulo.

**Endpoint**: `POST /v1/generate.transactions.withdraw`

**Query Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `priorityFee` | number | No | Priority fee in microlamports |

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner` | string | Yes | Wallet public key |
| `mintAddress` | string | Yes | Token mint address |
| `withdrawType` | string | Yes | `protected`, `boosted`, or `regular` |
| `amount` | number | Yes | Amount to withdraw |

**Example Request**:

```bash
curl -X POST "https://api.lulo.fi/v1/generate.transactions.withdraw?priorityFee=500000" \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "YourWalletPublicKey",
    "mintAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "withdrawType": "protected",
    "amount": 50000000
  }'
```

**Response**:

```json
{
  "transaction": "base64EncodedSerializedTransaction",
  "lastValidBlockHeight": 123456789
}
```

**Note**: Boosted withdrawals have a 48-hour cooldown period.

---

### Initialize Referrer Instructions

Sets up a referrer account for earning referral fees.

**Endpoint**: `POST /v1/referrer/initialize`

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `referrer` | string | Yes | Referrer wallet public key |
| `referralCode` | string | No | Custom referral code |

---

## Account Management

### Get Account Data

Retrieves user balances, interest earned, and APY metrics.

**Endpoint**: `GET /v1/account/{walletAddress}`

**Path Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `walletAddress` | string | User's wallet public key |

**Response**:

```json
{
  "totalDeposited": 1000000000,
  "totalInterestEarned": 5000000,
  "currentApy": 8.5,
  "positions": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "depositType": "protected",
      "balance": 500000000,
      "interestEarned": 2500000,
      "apy": 7.2,
      "protocol": "kamino"
    }
  ],
  "rewards": [
    {
      "mint": "TokenMintAddress",
      "symbol": "REWARD",
      "amount": 1000000,
      "claimable": true
    }
  ]
}
```

---

### Account History

Returns transaction events and performance data.

**Endpoint**: `GET /v1/account/{walletAddress}/history`

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Number of records (default: 50) |
| `offset` | number | Pagination offset |
| `type` | string | Filter by event type: `deposit`, `withdraw`, `rebalance` |

**Response**:

```json
{
  "events": [
    {
      "type": "deposit",
      "timestamp": 1704067200,
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": 100000000,
      "depositType": "protected",
      "signature": "txSignature123"
    },
    {
      "type": "rebalance",
      "timestamp": 1704070800,
      "fromProtocol": "drift",
      "toProtocol": "kamino",
      "amount": 100000000,
      "reason": "higher_yield"
    }
  ],
  "total": 150
}
```

---

### Pending Withdrawals

Lists active withdrawal requests with cooldown periods.

**Endpoint**: `GET /v1/account/{walletAddress}/pending-withdrawals`

**Response**:

```json
{
  "pendingWithdrawals": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": 50000000,
      "withdrawType": "boosted",
      "initiatedAt": 1704067200,
      "availableAt": 1704240000,
      "cooldownRemaining": 86400
    }
  ]
}
```

---

## Pool Information

### Pool Data

Returns current APY rates, liquidity amounts, and capacity metrics.

**Endpoint**: `GET /v1/pools`

**Response**:

```json
{
  "pools": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "decimals": 6,
      "protectedApy": 6.5,
      "boostedApy": 9.2,
      "customApy": 7.8,
      "totalDeposited": 34000000000000,
      "protectedDeposits": 20000000000000,
      "boostedDeposits": 14000000000000,
      "availableCapacity": 10000000000000,
      "coverageRatio": 0.7,
      "protocols": [
        {
          "name": "kamino",
          "apy": 6.8,
          "allocation": 0.35
        },
        {
          "name": "drift",
          "apy": 7.2,
          "allocation": 0.30
        },
        {
          "name": "marginfi",
          "apy": 6.5,
          "allocation": 0.25
        },
        {
          "name": "jupiter",
          "apy": 6.3,
          "allocation": 0.10
        }
      ]
    }
  ]
}
```

---

### Pool Statistics

Daily filled capacity, coverage ratios, and protocol distributions.

**Endpoint**: `GET /v1/pools/stats`

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `mint` | string | Filter by token mint |
| `period` | string | `24h`, `7d`, `30d` |

---

### Rates Feed

Historical and real-time APY data.

**Endpoint**: `GET /v1/rates`

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `mint` | string | Token mint address |
| `period` | string | `1h`, `24h`, `7d`, `30d` |
| `interval` | string | Data granularity: `1m`, `1h`, `1d` |

**Response**:

```json
{
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "rates": [
    {
      "timestamp": 1704067200,
      "protectedApy": 6.5,
      "boostedApy": 9.1,
      "bestProtocol": "drift",
      "bestProtocolApy": 7.3
    }
  ]
}
```

---

## Referrals

### Get Referrer Metadata

Tracks referred amounts, earnings, and referral codes.

**Endpoint**: `GET /v1/referrer/{referrerAddress}`

**Response**:

```json
{
  "referrer": "ReferrerPublicKey",
  "referralCode": "MYCODE",
  "totalReferred": 5000000000000,
  "totalEarnings": 50000000,
  "referralCount": 25,
  "pendingRewards": 5000000
}
```

---

### Claim Referral Rewards

Processes referral fee claims.

**Endpoint**: `POST /v1/referrer/claim`

**Request Body**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `referrer` | string | Yes | Referrer wallet public key |

**Response**:

```json
{
  "transaction": "base64EncodedTransaction",
  "claimAmount": 5000000
}
```

---

## Error Responses

All error responses follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "requestId": "unique-request-id"
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | Invalid parameters or request body |
| `UNAUTHORIZED` | 401 | Invalid or missing API key |
| `NOT_FOUND` | 404 | Account, pool, or resource not found |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |
| `INSUFFICIENT_BALANCE` | 400 | Not enough balance for operation |
| `COOLDOWN_ACTIVE` | 400 | Withdrawal cooldown period active |
| `CAPACITY_EXCEEDED` | 400 | Pool capacity limit reached |

---

## Rate Limits

| Tier | Requests/minute | Requests/day |
|------|-----------------|--------------|
| Free | 60 | 10,000 |
| Pro | 300 | 100,000 |
| Enterprise | Unlimited | Unlimited |

Contact the Lulo team for enterprise tier access.

---

## Webhooks

Configure webhooks in the developer portal to receive real-time notifications.

### Events

| Event | Description |
|-------|-------------|
| `deposit.completed` | Deposit transaction confirmed |
| `withdraw.completed` | Withdrawal transaction confirmed |
| `withdraw.available` | Boosted withdrawal cooldown ended |
| `rebalance.executed` | Funds moved to higher-yield protocol |
| `position.liquidated` | Protocol failure triggered protection |

### Payload Format

```json
{
  "event": "deposit.completed",
  "timestamp": 1704067200,
  "data": {
    "walletAddress": "UserWalletPubkey",
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 100000000,
    "depositType": "protected",
    "signature": "txSignature123"
  }
}
```
