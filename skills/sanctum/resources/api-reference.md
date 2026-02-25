# Sanctum API Reference

Complete API documentation for Sanctum's REST endpoints.

## Base URL

```
https://sanctum-api.ironforge.network
```

## Authentication

All endpoints require an `apiKey` query parameter:

```
?apiKey=YOUR_API_KEY
```

## Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Client error (invalid parameters) |
| 401 | Unauthenticated (missing/invalid API key) |
| 403 | Forbidden |
| 429 | Rate limited |
| 500 | Server error |
| 503 | Service unavailable |

## LST Metadata Endpoints

### GET /lsts

Returns metadata for all LSTs.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface LstMetadata {
  symbol: string;           // Token symbol (e.g., "mSOL")
  name: string;             // Full name
  mint: string;             // Token mint address
  decimals: number;         // Token decimals (usually 9)
  tokenProgram: string;     // SPL Token program ID
  logoUri: string;          // Logo URL
  tvl: number;              // Total Value Locked (SOL)
  apy: number;              // Current APY percentage
  holders: number;          // Number of holders
}

// Response is array of LstMetadata
type Response = LstMetadata[];
```

**Example:**
```bash
curl "https://sanctum-api.ironforge.network/lsts?apiKey=YOUR_KEY"
```

### GET /lsts/{mintOrSymbol}

Returns metadata for a specific LST.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| mintOrSymbol | string | Yes | Token mint address or symbol |
| apiKey | string | Yes | API key |

**Response:**
```typescript
type Response = LstMetadata;
```

**Example:**
```bash
# By symbol
curl "https://sanctum-api.ironforge.network/lsts/mSOL?apiKey=YOUR_KEY"

# By mint
curl "https://sanctum-api.ironforge.network/lsts/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So?apiKey=YOUR_KEY"
```

### GET /lsts/{mintOrSymbol}/apys

Returns historical APY data for an LST.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| mintOrSymbol | string | Yes | Token mint or symbol |
| limit | number | No | Number of epochs (default: all) |
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface ApyHistory {
  apys: Array<{
    epoch: number;        // Solana epoch number
    epochEndTs: number;   // Epoch end timestamp
    apy: number;          // APY for that epoch
  }>;
}
```

**Example:**
```bash
curl "https://sanctum-api.ironforge.network/lsts/INF/apys?apiKey=YOUR_KEY&limit=30"
```

## Validator Endpoints

### GET /validators/apy

Returns APY data for all validators.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface ValidatorApyResponse {
  [validatorVoteAccount: string]: {
    avgApy: number;
    timeseries: Array<{
      epoch: number;
      apy: number;
    }>;
  };
}
```

## Swap Endpoints

### GET /swap/token/order

Generates a swap quote and unsigned transaction.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| inp | string | Yes | Input token mint |
| out | string | Yes | Output token mint |
| amt | string | Yes | Amount (in smallest units) |
| mode | string | Yes | `ExactIn` or `ExactOut` |
| signer | string | Yes | Wallet public key |
| slippageBps | number | No | Slippage tolerance in bps |
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface SwapOrderResponse {
  tx: string;            // Base64 encoded transaction
  inpAmt: string;        // Input amount
  outAmt: string;        // Output amount
  source: string;        // Swap source (Infinity, Router, etc.)
  feeAmt: string;        // Fee amount
  feeMint: string;       // Fee token mint
  priceImpactBps: number; // Price impact in basis points
}
```

**Example:**
```bash
# Swap 1 SOL to mSOL (ExactIn)
curl "https://sanctum-api.ironforge.network/swap/token/order?\
apiKey=YOUR_KEY&\
inp=So11111111111111111111111111111111111111112&\
out=mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So&\
amt=1000000000&\
mode=ExactIn&\
signer=YOUR_WALLET&\
slippageBps=50"
```

**Mode Notes:**
- `ExactIn`: Specify exact input amount, output may vary
- `ExactOut`: Specify exact output amount, input may vary
- Some swap sources don't support `ExactOut`

### POST /swap/token/execute

Executes a signed swap transaction.

**Request Body:**
```typescript
interface SwapExecuteRequest {
  signedTx: string;          // Base64 encoded signed transaction
  orderResponse: SwapOrderResponse; // Original order response
}
```

**Response:**
```typescript
interface SwapExecuteResponse {
  txSignature: string;       // Transaction signature
}
```

**Example:**
```typescript
const response = await fetch(
  'https://sanctum-api.ironforge.network/swap/token/execute',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTx: signedTransaction.toString('base64'),
      orderResponse: orderResponse,
    }),
  }
);
```

## Stake Account Endpoints

### GET /swap/depositStake/order

Generate transaction to deposit a native stake account for LST.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| stakeAccount | string | Yes | Stake account public key |
| outputLstMint | string | Yes | Desired output LST mint |
| signer | string | Yes | Wallet public key |
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface DepositStakeOrderResponse {
  tx: string;              // Base64 encoded transaction
  outAmt: string;          // Expected LST output amount
  stakeAccountLamports: string; // Stake account value
}
```

### POST /swap/depositStake/execute

Execute a signed deposit stake transaction.

**Request Body:**
```typescript
interface DepositStakeExecuteRequest {
  signedTx: string;
  orderResponse: DepositStakeOrderResponse;
}
```

### GET /swap/withdrawStake/order

Generate transaction to withdraw LST to a stake account.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| lstMint | string | Yes | LST mint to withdraw |
| amount | string | Yes | Amount to withdraw |
| signer | string | Yes | Wallet public key |
| deactivate | boolean | No | Auto-deactivate stake (default: true) |
| apiKey | string | Yes | API key |

**Response:**
```typescript
interface WithdrawStakeOrderResponse {
  tx: string;              // Base64 encoded transaction
  stakeAccount: string;    // New stake account address
  lamports: string;        // Expected lamports in stake account
}
```

### POST /swap/withdrawStake/execute

Execute a signed withdraw stake transaction.

## TypeScript Client

```typescript
class SanctumApiClient {
  private baseUrl = 'https://sanctum-api.ironforge.network';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async get<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set('apiKey', this.apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return response.json();
  }

  private async post<T>(endpoint: string, body: object): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}?apiKey=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return response.json();
  }

  // LST Methods
  async getLsts(): Promise<LstMetadata[]> {
    return this.get('/lsts');
  }

  async getLst(mintOrSymbol: string): Promise<LstMetadata> {
    return this.get(`/lsts/${mintOrSymbol}`);
  }

  async getLstApys(mintOrSymbol: string, limit?: number): Promise<ApyHistory> {
    const params: Record<string, string> = {};
    if (limit) params.limit = limit.toString();
    return this.get(`/lsts/${mintOrSymbol}/apys`, params);
  }

  // Validator Methods
  async getValidatorApys(): Promise<ValidatorApyResponse> {
    return this.get('/validators/apy');
  }

  // Swap Methods
  async getSwapOrder(params: {
    inp: string;
    out: string;
    amt: string;
    mode: 'ExactIn' | 'ExactOut';
    signer: string;
    slippageBps?: number;
  }): Promise<SwapOrderResponse> {
    return this.get('/swap/token/order', {
      inp: params.inp,
      out: params.out,
      amt: params.amt,
      mode: params.mode,
      signer: params.signer,
      ...(params.slippageBps && { slippageBps: params.slippageBps.toString() }),
    });
  }

  async executeSwap(signedTx: string, orderResponse: SwapOrderResponse): Promise<SwapExecuteResponse> {
    return this.post('/swap/token/execute', { signedTx, orderResponse });
  }

  // Stake Account Methods
  async getDepositStakeOrder(params: {
    stakeAccount: string;
    outputLstMint: string;
    signer: string;
  }): Promise<DepositStakeOrderResponse> {
    return this.get('/swap/depositStake/order', params);
  }

  async executeDepositStake(signedTx: string, orderResponse: DepositStakeOrderResponse): Promise<SwapExecuteResponse> {
    return this.post('/swap/depositStake/execute', { signedTx, orderResponse });
  }

  async getWithdrawStakeOrder(params: {
    lstMint: string;
    amount: string;
    signer: string;
    deactivate?: boolean;
  }): Promise<WithdrawStakeOrderResponse> {
    return this.get('/swap/withdrawStake/order', {
      lstMint: params.lstMint,
      amount: params.amount,
      signer: params.signer,
      deactivate: (params.deactivate ?? true).toString(),
    });
  }

  async executeWithdrawStake(signedTx: string, orderResponse: WithdrawStakeOrderResponse): Promise<SwapExecuteResponse> {
    return this.post('/swap/withdrawStake/execute', { signedTx, orderResponse });
  }
}
```

## Rate Limits

The API has rate limits in place. If you receive a 429 response:
- Implement exponential backoff
- Consider caching LST metadata
- Batch requests where possible

## Error Handling

```typescript
interface ApiError {
  error: string;
  message: string;
  details?: object;
}

async function handleApiCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error.status === 429) {
      // Rate limited - wait and retry
      await sleep(1000);
      return call();
    }
    if (error.status === 400) {
      // Invalid parameters
      console.error('Invalid request:', error.message);
    }
    throw error;
  }
}
```
