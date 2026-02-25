# Smart Account Program API Reference

API reference for the Squads Smart Account Program and REST API.

## Overview

The Smart Account Program provides account abstraction features for Solana:
- Session keys with delegated permissions
- Passkey/WebAuthn authentication
- Policy-based transaction execution
- Direct debits and subscriptions

## Program ID

```
SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG
```

## REST API Base URL

```
https://developer-api.squads.so/api/v1
```

---

## Authentication

### Email OTP

Request an OTP code:

```typescript
POST /auth/email/otp
Content-Type: application/json

{
  "email": "user@example.com"
}

// Response
{
  "success": true,
  "message": "OTP sent to email"
}
```

Verify OTP:

```typescript
POST /auth/email/verify
Content-Type: application/json

{
  "email": "user@example.com",
  "otp": "123456"
}

// Response
{
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG...",
  "expiresIn": 3600
}
```

### Passkey Authentication

Register a passkey:

```typescript
POST /auth/passkey/register
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "credentialId": "base64-credential-id",
  "publicKey": "base64-public-key",
  "attestation": {
    // WebAuthn attestation object
  }
}

// Response
{
  "success": true,
  "passkeyId": "pk_..."
}
```

Authenticate with passkey:

```typescript
POST /auth/passkey/authenticate
Content-Type: application/json

{
  "credentialId": "base64-credential-id",
  "assertion": {
    // WebAuthn assertion object
  }
}

// Response
{
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG...",
  "expiresIn": 3600
}
```

### Refresh Token

```typescript
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbG..."
}

// Response
{
  "accessToken": "eyJhbG...",
  "expiresIn": 3600
}
```

---

## Accounts

### Create Account

```typescript
POST /accounts
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "name": "My Wallet",
  "type": "personal" | "business"
}

// Response
{
  "id": "acc_...",
  "address": "ABC123...", // Solana address
  "name": "My Wallet",
  "type": "personal",
  "status": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Get Account

```typescript
GET /accounts/{accountId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "acc_...",
  "address": "ABC123...",
  "name": "My Wallet",
  "type": "personal",
  "status": "active",
  "balance": {
    "SOL": "1.5",
    "USDC": "100.00"
  },
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### List Accounts

```typescript
GET /accounts
Authorization: Bearer {accessToken}

// Response
{
  "accounts": [
    {
      "id": "acc_...",
      "address": "ABC123...",
      "name": "My Wallet",
      "type": "personal",
      "status": "active"
    }
  ],
  "total": 1
}
```

### Update Account

```typescript
PATCH /accounts/{accountId}
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "name": "Updated Wallet Name"
}

// Response
{
  "success": true
}
```

---

## Session Keys

### Create Session Key

```typescript
POST /accounts/{accountId}/sessions
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "publicKey": "SessionKeyPublicKey...",
  "name": "Mobile App Session",
  "expiresAt": "2024-02-15T10:30:00Z",
  "permissions": ["transfer", "swap"],
  "limits": {
    "perTransaction": "1000000000", // 1 SOL in lamports
    "daily": "5000000000", // 5 SOL daily
    "allowedMints": ["So11111111111111111111111111111111111111112"],
    "allowedDestinations": ["Dest1...", "Dest2..."]
  }
}

// Response
{
  "id": "sess_...",
  "publicKey": "SessionKeyPublicKey...",
  "name": "Mobile App Session",
  "expiresAt": "2024-02-15T10:30:00Z",
  "permissions": ["transfer", "swap"],
  "status": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### List Session Keys

```typescript
GET /accounts/{accountId}/sessions
Authorization: Bearer {accessToken}

// Response
{
  "sessions": [
    {
      "id": "sess_...",
      "publicKey": "SessionKeyPublicKey...",
      "name": "Mobile App Session",
      "expiresAt": "2024-02-15T10:30:00Z",
      "permissions": ["transfer", "swap"],
      "status": "active"
    }
  ],
  "total": 1
}
```

### Revoke Session Key

```typescript
DELETE /accounts/{accountId}/sessions/{sessionId}
Authorization: Bearer {accessToken}

// Response
{
  "success": true
}
```

---

## Policies

### Create Policy

```typescript
POST /accounts/{accountId}/policies
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "type": "spending_limit",
  "name": "Daily USDC Limit",
  "params": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "amount": "10000000000", // 10,000 USDC
    "period": "daily"
  }
}

// Response
{
  "id": "pol_...",
  "type": "spending_limit",
  "name": "Daily USDC Limit",
  "params": {...},
  "status": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Policy Types

| Type | Description |
|------|-------------|
| `spending_limit` | Limit spending per period |
| `allowlist` | Only allow specific destinations |
| `blocklist` | Block specific destinations |
| `time_window` | Only allow during certain hours |
| `approval_required` | Require additional approval |

### List Policies

```typescript
GET /accounts/{accountId}/policies
Authorization: Bearer {accessToken}

// Response
{
  "policies": [
    {
      "id": "pol_...",
      "type": "spending_limit",
      "name": "Daily USDC Limit",
      "status": "active"
    }
  ],
  "total": 1
}
```

### Update Policy

```typescript
PATCH /accounts/{accountId}/policies/{policyId}
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "params": {
    "amount": "20000000000" // Update limit to 20,000
  }
}

// Response
{
  "success": true
}
```

### Delete Policy

```typescript
DELETE /accounts/{accountId}/policies/{policyId}
Authorization: Bearer {accessToken}

// Response
{
  "success": true
}
```

---

## Transactions

### Execute Transaction

```typescript
POST /accounts/{accountId}/transactions
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "instructions": [
    {
      "programId": "11111111111111111111111111111111",
      "accounts": [
        { "pubkey": "FromAddress...", "isSigner": true, "isWritable": true },
        { "pubkey": "ToAddress...", "isSigner": false, "isWritable": true }
      ],
      "data": "base64-encoded-data"
    }
  ],
  "sessionKeySignature": "base64-signature" // Optional, for session key auth
}

// Response
{
  "id": "tx_...",
  "signature": "5wH7k...",
  "status": "confirmed",
  "slot": 123456789
}
```

### Get Transaction

```typescript
GET /accounts/{accountId}/transactions/{transactionId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "tx_...",
  "signature": "5wH7k...",
  "status": "confirmed",
  "instructions": [...],
  "fee": "5000",
  "slot": 123456789,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### List Transactions

```typescript
GET /accounts/{accountId}/transactions?limit=20&offset=0
Authorization: Bearer {accessToken}

// Response
{
  "transactions": [
    {
      "id": "tx_...",
      "signature": "5wH7k...",
      "status": "confirmed",
      "timestamp": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 100,
  "limit": 20,
  "offset": 0
}
```

---

## Direct Debits

### Create Direct Debit Authorization

```typescript
POST /accounts/{accountId}/direct-debits
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "merchant": "MerchantAddress...",
  "merchantName": "Acme Corp",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "maxAmount": "100000000", // Max 100 USDC per debit
  "frequency": "monthly",
  "expiresAt": "2025-01-15T10:30:00Z"
}

// Response
{
  "id": "dd_...",
  "merchant": "MerchantAddress...",
  "merchantName": "Acme Corp",
  "status": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### List Direct Debits

```typescript
GET /accounts/{accountId}/direct-debits
Authorization: Bearer {accessToken}

// Response
{
  "directDebits": [
    {
      "id": "dd_...",
      "merchant": "MerchantAddress...",
      "merchantName": "Acme Corp",
      "status": "active",
      "lastDebit": "2024-01-01T10:30:00Z",
      "nextDebit": "2024-02-01T10:30:00Z"
    }
  ],
  "total": 1
}
```

### Cancel Direct Debit

```typescript
DELETE /accounts/{accountId}/direct-debits/{directDebitId}
Authorization: Bearer {accessToken}

// Response
{
  "success": true
}
```

---

## Subscriptions

### Create Subscription

```typescript
POST /accounts/{accountId}/subscriptions
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "merchant": "MerchantAddress...",
  "merchantName": "Streaming Service",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "9990000", // $9.99 USDC
  "frequency": "monthly",
  "startDate": "2024-02-01"
}

// Response
{
  "id": "sub_...",
  "merchant": "MerchantAddress...",
  "merchantName": "Streaming Service",
  "amount": "9990000",
  "frequency": "monthly",
  "status": "active",
  "nextPayment": "2024-02-01T00:00:00Z"
}
```

### Pause Subscription

```typescript
POST /accounts/{accountId}/subscriptions/{subscriptionId}/pause
Authorization: Bearer {accessToken}

// Response
{
  "success": true,
  "status": "paused"
}
```

### Resume Subscription

```typescript
POST /accounts/{accountId}/subscriptions/{subscriptionId}/resume
Authorization: Bearer {accessToken}

// Response
{
  "success": true,
  "status": "active",
  "nextPayment": "2024-03-01T00:00:00Z"
}
```

### Cancel Subscription

```typescript
DELETE /accounts/{accountId}/subscriptions/{subscriptionId}
Authorization: Bearer {accessToken}

// Response
{
  "success": true
}
```

---

## Error Responses

All error responses follow this format:

```typescript
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {} // Optional additional info
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or expired token |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `POLICY_VIOLATION` | 400 | Transaction violates policy |
| `INSUFFICIENT_BALANCE` | 400 | Not enough balance |
| `SESSION_EXPIRED` | 401 | Session key has expired |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limits

| Endpoint Type | Limit |
|--------------|-------|
| Authentication | 10 requests/minute |
| Read operations | 100 requests/minute |
| Write operations | 30 requests/minute |
| Transaction execution | 10 requests/minute |

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705320000
```
