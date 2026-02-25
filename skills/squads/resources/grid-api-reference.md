# Grid API Reference

REST API reference for Squads Grid - stablecoin rails and fintech infrastructure.

## Overview

Grid provides open finance infrastructure for:
- Stablecoin payments and transfers
- Neobank and fintech platforms
- Virtual accounts and fiat rails
- KYC/AML compliance integration

## Base URL

```
https://developer-api.squads.so/api/v1
```

## SDKs

```bash
# TypeScript SDK
npm install @sqds/grid

# React Native SDK
npm install @sqds/grid-react-native
```

---

## Authentication

### API Key Authentication

For server-to-server calls:

```typescript
GET /endpoint
Authorization: Bearer {apiKey}
X-API-Version: 2024-01
```

### User Authentication

For user-facing applications, use email OTP or passkey authentication (see Smart Account API Reference).

---

## Accounts

### Create User Account

```typescript
POST /grid/accounts
Content-Type: application/json
Authorization: Bearer {apiKey}

{
  "email": "user@example.com",
  "type": "individual",
  "metadata": {
    "referralCode": "REF123"
  }
}

// Response
{
  "id": "grid_acc_...",
  "email": "user@example.com",
  "type": "individual",
  "status": "pending_verification",
  "address": "SolanaAddress...",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Account Types

| Type | Description |
|------|-------------|
| `individual` | Personal account |
| `business` | Business/corporate account |
| `custodial` | Custodial account managed by platform |

### Get Account Details

```typescript
GET /grid/accounts/{accountId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "grid_acc_...",
  "email": "user@example.com",
  "type": "individual",
  "status": "active",
  "address": "SolanaAddress...",
  "balances": [
    { "mint": "USDC", "amount": "1000.00", "available": "950.00", "pending": "50.00" },
    { "mint": "USDT", "amount": "500.00", "available": "500.00", "pending": "0.00" }
  ],
  "limits": {
    "daily": { "used": "100.00", "limit": "10000.00" },
    "monthly": { "used": "500.00", "limit": "50000.00" }
  },
  "kycStatus": "verified",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Update Account

```typescript
PATCH /grid/accounts/{accountId}
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "metadata": {
    "preferredCurrency": "USD"
  }
}

// Response
{
  "success": true
}
```

---

## KYC Verification

### Start KYC Flow

```typescript
POST /grid/accounts/{accountId}/kyc
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "provider": "persona", // KYC provider
  "redirectUrl": "https://yourapp.com/kyc-complete"
}

// Response
{
  "inquiryId": "inq_...",
  "kycUrl": "https://withpersona.com/verify?inquiry-id=inq_...",
  "expiresAt": "2024-01-15T11:30:00Z"
}
```

### Check KYC Status

```typescript
GET /grid/accounts/{accountId}/kyc
Authorization: Bearer {accessToken}

// Response
{
  "status": "verified" | "pending" | "failed" | "not_started",
  "level": "basic" | "enhanced" | "full",
  "verifiedAt": "2024-01-15T10:30:00Z",
  "expiresAt": "2025-01-15T10:30:00Z"
}
```

### KYC Levels

| Level | Requirements | Limits |
|-------|-------------|--------|
| `basic` | Email verification | $1,000/day |
| `enhanced` | ID + selfie | $10,000/day |
| `full` | ID + proof of address | $100,000/day |

---

## Payments

### Create Payment

```typescript
POST /grid/payments
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "fromAccountId": "grid_acc_...",
  "toAddress": "RecipientSolanaAddress...",
  "amount": "100.00",
  "currency": "USDC",
  "memo": "Payment for invoice #123",
  "idempotencyKey": "unique-key-123"
}

// Response
{
  "id": "pmt_...",
  "status": "pending",
  "amount": "100.00",
  "currency": "USDC",
  "fee": "0.10",
  "fromAccountId": "grid_acc_...",
  "toAddress": "RecipientSolanaAddress...",
  "memo": "Payment for invoice #123",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Payment Statuses

| Status | Description |
|--------|-------------|
| `pending` | Payment created, processing |
| `processing` | Transaction submitted to network |
| `completed` | Payment successful |
| `failed` | Payment failed |
| `cancelled` | Payment cancelled |
| `refunded` | Payment refunded |

### Get Payment

```typescript
GET /grid/payments/{paymentId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "pmt_...",
  "status": "completed",
  "amount": "100.00",
  "currency": "USDC",
  "fee": "0.10",
  "signature": "SolanaTransactionSignature...",
  "confirmedAt": "2024-01-15T10:31:00Z"
}
```

### List Payments

```typescript
GET /grid/payments?accountId={accountId}&limit=20&status=completed
Authorization: Bearer {accessToken}

// Response
{
  "payments": [
    {
      "id": "pmt_...",
      "status": "completed",
      "amount": "100.00",
      "currency": "USDC",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 50,
  "hasMore": true,
  "cursor": "cursor_..."
}
```

### Cancel Payment

```typescript
POST /grid/payments/{paymentId}/cancel
Authorization: Bearer {accessToken}

// Response
{
  "success": true,
  "status": "cancelled"
}
```

---

## Standing Orders (Recurring Payments)

### Create Standing Order

```typescript
POST /grid/standing-orders
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "fromAccountId": "grid_acc_...",
  "toAddress": "RecipientAddress...",
  "amount": "50.00",
  "currency": "USDC",
  "frequency": "monthly",
  "startDate": "2024-02-01",
  "endDate": "2025-02-01", // Optional
  "memo": "Monthly rent payment"
}

// Response
{
  "id": "so_...",
  "status": "active",
  "amount": "50.00",
  "currency": "USDC",
  "frequency": "monthly",
  "nextExecution": "2024-02-01T00:00:00Z",
  "totalExecuted": 0,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Frequency Options

| Frequency | Description |
|-----------|-------------|
| `daily` | Every day |
| `weekly` | Every week |
| `biweekly` | Every two weeks |
| `monthly` | Every month |
| `quarterly` | Every three months |
| `yearly` | Every year |

### Get Standing Order

```typescript
GET /grid/standing-orders/{standingOrderId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "so_...",
  "status": "active",
  "amount": "50.00",
  "currency": "USDC",
  "frequency": "monthly",
  "nextExecution": "2024-03-01T00:00:00Z",
  "lastExecution": "2024-02-01T00:01:23Z",
  "totalExecuted": 1,
  "executions": [
    {
      "paymentId": "pmt_...",
      "executedAt": "2024-02-01T00:01:23Z",
      "status": "completed"
    }
  ]
}
```

### Update Standing Order

```typescript
PATCH /grid/standing-orders/{standingOrderId}
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "amount": "60.00", // Update amount
  "endDate": "2026-02-01" // Extend end date
}

// Response
{
  "success": true
}
```

### Pause Standing Order

```typescript
POST /grid/standing-orders/{standingOrderId}/pause
Authorization: Bearer {accessToken}

// Response
{
  "success": true,
  "status": "paused"
}
```

### Resume Standing Order

```typescript
POST /grid/standing-orders/{standingOrderId}/resume
Authorization: Bearer {accessToken}

// Response
{
  "success": true,
  "status": "active",
  "nextExecution": "2024-04-01T00:00:00Z"
}
```

### Cancel Standing Order

```typescript
DELETE /grid/standing-orders/{standingOrderId}
Authorization: Bearer {accessToken}

// Response
{
  "success": true
}
```

---

## Virtual Accounts (Fiat Rails)

### Create Virtual Account

```typescript
POST /grid/virtual-accounts
Content-Type: application/json
Authorization: Bearer {apiKey}

{
  "accountId": "grid_acc_...",
  "currency": "USD",
  "type": "checking"
}

// Response
{
  "id": "va_...",
  "accountId": "grid_acc_...",
  "currency": "USD",
  "type": "checking",
  "routingNumber": "021000021",
  "accountNumber": "123456789",
  "bankName": "Partner Bank",
  "status": "active",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Get Virtual Account

```typescript
GET /grid/virtual-accounts/{virtualAccountId}
Authorization: Bearer {accessToken}

// Response
{
  "id": "va_...",
  "accountId": "grid_acc_...",
  "currency": "USD",
  "routingNumber": "021000021",
  "accountNumber": "123456789",
  "balance": "500.00",
  "status": "active"
}
```

### Deposit to Virtual Account

When funds are deposited to the virtual account (via ACH, wire, etc.), they are automatically converted to USDC and credited to the Grid account.

### Withdraw from Virtual Account

```typescript
POST /grid/virtual-accounts/{virtualAccountId}/withdraw
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "amount": "100.00",
  "method": "ach",
  "destination": {
    "routingNumber": "021000021",
    "accountNumber": "987654321",
    "accountType": "checking"
  }
}

// Response
{
  "id": "wd_...",
  "status": "pending",
  "amount": "100.00",
  "fee": "1.00",
  "estimatedArrival": "2024-01-18T10:30:00Z"
}
```

---

## Spending Limits

### Set Spending Limit

```typescript
POST /grid/accounts/{accountId}/limits
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "type": "daily",
  "amount": "1000.00",
  "currency": "USDC"
}

// Response
{
  "id": "lim_...",
  "type": "daily",
  "amount": "1000.00",
  "currency": "USDC",
  "used": "0.00",
  "resetsAt": "2024-01-16T00:00:00Z"
}
```

### Limit Types

| Type | Description |
|------|-------------|
| `per_transaction` | Maximum per single transaction |
| `daily` | Maximum per day |
| `weekly` | Maximum per week |
| `monthly` | Maximum per month |

### Get Limits

```typescript
GET /grid/accounts/{accountId}/limits
Authorization: Bearer {accessToken}

// Response
{
  "limits": [
    {
      "id": "lim_...",
      "type": "daily",
      "amount": "1000.00",
      "used": "150.00",
      "remaining": "850.00",
      "resetsAt": "2024-01-16T00:00:00Z"
    }
  ]
}
```

### Update Limit

```typescript
PATCH /grid/accounts/{accountId}/limits/{limitId}
Content-Type: application/json
Authorization: Bearer {accessToken}

{
  "amount": "2000.00"
}

// Response
{
  "success": true
}
```

---

## Webhooks

### Configure Webhook

```typescript
POST /grid/webhooks
Content-Type: application/json
Authorization: Bearer {apiKey}

{
  "url": "https://yourapp.com/webhooks/grid",
  "events": [
    "payment.completed",
    "payment.failed",
    "account.verified",
    "standing_order.executed"
  ],
  "secret": "whsec_..." // Provided or generated
}

// Response
{
  "id": "wh_...",
  "url": "https://yourapp.com/webhooks/grid",
  "events": [...],
  "status": "active",
  "secret": "whsec_..."
}
```

### Webhook Events

| Event | Description |
|-------|-------------|
| `payment.created` | Payment initiated |
| `payment.completed` | Payment successful |
| `payment.failed` | Payment failed |
| `account.created` | Account created |
| `account.verified` | KYC completed |
| `standing_order.executed` | Recurring payment executed |
| `standing_order.failed` | Recurring payment failed |
| `virtual_account.credited` | Deposit received |

### Webhook Payload

```typescript
{
  "id": "evt_...",
  "type": "payment.completed",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "paymentId": "pmt_...",
    "amount": "100.00",
    "currency": "USDC",
    "status": "completed"
  }
}
```

### Verify Webhook Signature

```typescript
import crypto from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

---

## Error Handling

### Error Response Format

```typescript
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Account balance is insufficient for this payment",
    "details": {
      "required": "100.00",
      "available": "50.00",
      "currency": "USDC"
    }
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid credentials |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid parameters |
| `INSUFFICIENT_FUNDS` | 400 | Not enough balance |
| `LIMIT_EXCEEDED` | 400 | Spending limit exceeded |
| `KYC_REQUIRED` | 403 | KYC verification needed |
| `ACCOUNT_FROZEN` | 403 | Account is frozen |
| `DUPLICATE_REQUEST` | 409 | Idempotency key reused |
| `RATE_LIMITED` | 429 | Too many requests |

---

## Rate Limits

| Endpoint Type | Limit |
|--------------|-------|
| Read operations | 100 requests/minute |
| Payment operations | 30 requests/minute |
| Account creation | 10 requests/minute |

---

## SDK Usage

### TypeScript SDK

```typescript
import { GridClient } from '@sqds/grid';

const grid = new GridClient({
  apiKey: process.env.GRID_API_KEY,
  environment: 'production', // or 'sandbox'
});

// Create payment
const payment = await grid.payments.create({
  fromAccountId: 'grid_acc_...',
  toAddress: 'RecipientAddress...',
  amount: '100.00',
  currency: 'USDC',
});

// Create standing order
const standingOrder = await grid.standingOrders.create({
  fromAccountId: 'grid_acc_...',
  toAddress: 'RecipientAddress...',
  amount: '50.00',
  currency: 'USDC',
  frequency: 'monthly',
  startDate: '2024-02-01',
});
```

### React Native SDK

```typescript
import { useGrid } from '@sqds/grid-react-native';

function PaymentScreen() {
  const { createPayment, isLoading } = useGrid();

  const handlePayment = async () => {
    const payment = await createPayment({
      toAddress: recipientAddress,
      amount: '100.00',
      currency: 'USDC',
    });

    console.log('Payment created:', payment.id);
  };

  return (
    <Button onPress={handlePayment} disabled={isLoading}>
      Send Payment
    </Button>
  );
}
```
