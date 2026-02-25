# Lulo Troubleshooting Guide

Common issues and solutions when integrating with Lulo.

## API Issues

### "UNAUTHORIZED" Error

**Problem**: API requests return 401 Unauthorized.

**Solutions**:

1. Verify your API key is correct:
```typescript
// Check if API key is set
console.log('API Key:', process.env.LULO_API_KEY ? 'Set' : 'Missing');
```

2. Ensure the header is correctly formatted:
```typescript
const headers = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.LULO_API_KEY, // Note: lowercase 'x-api-key'
};
```

3. Get a new API key from [dev.lulo.fi](https://dev.lulo.fi)

---

### "BAD_REQUEST" Error

**Problem**: API returns 400 Bad Request.

**Solutions**:

1. Check required parameters:
```typescript
// Deposit requires these fields
const body = {
  owner: walletPublicKey,      // Required: string
  mintAddress: tokenMint,       // Required: valid mint address
  depositType: 'protected',     // Required: 'protected', 'boosted', or 'regular'
  amount: 100000000,            // Required: positive integer
};
```

2. Verify mint address is supported:
```typescript
const SUPPORTED_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',   // SOL
];
```

3. Check amount meets minimum:
   - Stablecoins: $100 minimum (100_000_000 for USDC/USDT)
   - SOL: 1 SOL minimum (1_000_000_000)

---

### "NOT_FOUND" Error

**Problem**: Account or resource not found.

**Solutions**:

1. Verify wallet address is correct:
```typescript
import { PublicKey } from '@solana/web3.js';

try {
  new PublicKey(walletAddress); // Validates address format
} catch {
  console.error('Invalid wallet address');
}
```

2. Check if account has been initialized (first deposit required)

3. For pending withdrawals, ensure the account has active withdrawals

---

### "RATE_LIMITED" Error

**Problem**: Too many API requests.

**Solutions**:

1. Implement rate limiting:
```typescript
const rateLimit = {
  requests: 0,
  resetTime: Date.now() + 60000,
};

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  if (Date.now() > rateLimit.resetTime) {
    rateLimit.requests = 0;
    rateLimit.resetTime = Date.now() + 60000;
  }

  if (rateLimit.requests >= 60) {
    const waitTime = rateLimit.resetTime - Date.now();
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimit.requests = 0;
    rateLimit.resetTime = Date.now() + 60000;
  }

  rateLimit.requests++;
  return fn();
}
```

2. Cache responses where appropriate:
```typescript
let cachedPools: LuloPool[] | null = null;
let cacheTime = 0;

async function getCachedPools(): Promise<LuloPool[]> {
  // Cache for 5 minutes (rates update hourly)
  if (cachedPools && Date.now() - cacheTime < 300000) {
    return cachedPools;
  }

  cachedPools = await fetchPools();
  cacheTime = Date.now();
  return cachedPools;
}
```

---

## Transaction Issues

### "Transaction simulation failed"

**Problem**: Transaction fails during simulation.

**Solutions**:

1. Check simulation logs:
```typescript
const connection = new Connection(RPC_URL);

// Simulate before sending
const txBuffer = Buffer.from(serializedTx, 'base64');
const tx = VersionedTransaction.deserialize(txBuffer);

const simulation = await connection.simulateTransaction(tx);
if (simulation.value.err) {
  console.error('Simulation error:', simulation.value.err);
  console.log('Logs:', simulation.value.logs);
}
```

2. Ensure sufficient balance:
```typescript
async function checkBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
  requiredAmount: number
): Promise<boolean> {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet, {
    mint: new PublicKey(mint),
  });

  if (accounts.value.length === 0) return false;

  const balance = parseInt(
    accounts.value[0].account.data.parsed.info.tokenAmount.amount
  );

  return balance >= requiredAmount;
}
```

3. Check for sufficient SOL for fees:
```typescript
const solBalance = await connection.getBalance(wallet);
const MIN_SOL_FOR_FEES = 0.01 * 1e9; // 0.01 SOL

if (solBalance < MIN_SOL_FOR_FEES) {
  throw new Error('Insufficient SOL for transaction fees');
}
```

---

### "Blockhash expired"

**Problem**: Transaction took too long to land.

**Solutions**:

1. Get fresh blockhash before sending:
```typescript
// Lulo API returns transaction with blockhash, but if it expires:
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

// Update transaction blockhash if needed
transaction.message.recentBlockhash = blockhash;
```

2. Implement retry with fresh transaction:
```typescript
async function sendWithRetry(
  generateTx: () => Promise<string>,
  wallet: Keypair,
  maxRetries: number = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Get fresh transaction each retry
      const serializedTx = await generateTx();
      const tx = VersionedTransaction.deserialize(
        Buffer.from(serializedTx, 'base64')
      );
      tx.sign([wallet]);

      const signature = await connection.sendTransaction(tx);
      await connection.confirmTransaction(signature);
      return signature;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Transaction failed after all retries');
}
```

---

### Priority Fee Too Low

**Problem**: Transaction not being included in blocks.

**Solutions**:

1. Increase priority fee:
```typescript
// Default is 500000, try higher during congestion
const priorityFee = 1_000_000; // 1M microlamports

const response = await fetch(
  `${LULO_API_URL}/v1/generate.transactions.deposit?priorityFee=${priorityFee}`,
  // ...
);
```

2. Use dynamic priority fees based on network conditions:
```typescript
async function getRecommendedPriorityFee(connection: Connection): Promise<number> {
  const recentFees = await connection.getRecentPrioritizationFees();

  if (recentFees.length === 0) return 500000;

  // Use median of recent fees
  const fees = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
  const median = fees[Math.floor(fees.length / 2)];

  return Math.max(median * 1.5, 500000); // At least 500k
}
```

---

## Withdrawal Issues

### Boosted Withdrawal Cooldown

**Problem**: Cannot withdraw Boosted deposits immediately.

**Solution**:

1. Check cooldown status:
```typescript
const pending = await lulo.getPendingWithdrawals();

for (const withdrawal of pending) {
  if (withdrawal.cooldownRemaining > 0) {
    const hoursRemaining = withdrawal.cooldownRemaining / 3600;
    console.log(`${hoursRemaining.toFixed(1)} hours remaining`);
  } else {
    console.log('Ready to complete withdrawal');
  }
}
```

2. Wait for cooldown to complete (48 hours for Boosted)

3. Complete withdrawal after cooldown:
```typescript
const availableWithdrawals = pending.filter(w => w.cooldownRemaining <= 0);

for (const withdrawal of availableWithdrawals) {
  await lulo.withdraw(withdrawal.mint, withdrawal.amount, 'boosted');
}
```

---

### "Insufficient Balance" on Withdrawal

**Problem**: Withdrawal fails due to insufficient balance.

**Solutions**:

1. Check actual position balance:
```typescript
const account = await lulo.getAccount();
const position = account.positions.find(
  p => p.mint === mintAddress && p.depositType === withdrawType
);

if (!position) {
  console.error('No position found');
} else {
  console.log('Available balance:', position.balance);
}
```

2. Withdraw only available amount:
```typescript
// Don't try to withdraw more than deposited
const maxWithdraw = Math.min(requestedAmount, position.balance);
```

---

## Connection Issues

### RPC Errors

**Problem**: RPC connection failures or timeouts.

**Solutions**:

1. Use a reliable RPC provider:
```typescript
// Free public RPCs are rate-limited, consider:
const RPC_URLS = {
  helius: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
  quicknode: `https://solana-mainnet.core.chainstack.com/${QUICKNODE_KEY}`,
  alchemy: `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};
```

2. Implement connection fallback:
```typescript
const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
];

async function getWorkingConnection(): Promise<Connection> {
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const connection = new Connection(endpoint);
      await connection.getLatestBlockhash(); // Test connection
      return connection;
    } catch {
      continue;
    }
  }
  throw new Error('All RPC endpoints failed');
}
```

3. Handle connection errors gracefully:
```typescript
async function withConnectionRetry<T>(
  fn: (connection: Connection) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let connection = new Connection(RPC_URL);

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn(connection);
    } catch (error) {
      if (i === maxRetries - 1) throw error;

      // Try different endpoint on failure
      connection = await getWorkingConnection();
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  throw new Error('Operation failed after retries');
}
```

---

## Common Mistakes

### Wrong Token Decimals

**Problem**: Depositing wrong amount due to decimal mismatch.

**Solution**:
```typescript
const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,  // 100 USDC = 100_000_000
  USDT: 6,  // 100 USDT = 100_000_000
  SOL: 9,   // 1 SOL = 1_000_000_000
};

function toUnits(amount: number, token: string): number {
  const decimals = TOKEN_DECIMALS[token] || 6;
  return Math.floor(amount * Math.pow(10, decimals));
}

// Correct: Deposit 100 USDC
const amount = toUnits(100, 'USDC'); // 100_000_000
```

---

### Not Handling Async Properly

**Problem**: Transactions fail due to race conditions.

**Solution**:
```typescript
// Wrong: Not awaiting properly
deposit(connection, wallet, mint, amount);
withdraw(connection, wallet, mint, amount); // May fail!

// Correct: Wait for operations to complete
const depositSig = await deposit(connection, wallet, mint, amount);
console.log('Deposit confirmed:', depositSig);

const withdrawSig = await withdraw(connection, wallet, mint, amount);
console.log('Withdrawal confirmed:', withdrawSig);
```

---

### Ignoring Error Responses

**Problem**: Silent failures due to unchecked errors.

**Solution**:
```typescript
// Always check API responses
const response = await fetch(endpoint, options);

if (!response.ok) {
  const error = await response.json();
  console.error('API Error:', {
    status: response.status,
    code: error.error?.code,
    message: error.error?.message,
    requestId: error.error?.requestId,
  });
  throw new Error(`API Error: ${error.error?.message || response.statusText}`);
}
```

---

## Getting Help

1. **Check documentation**: [docs.lulo.fi](https://docs.lulo.fi)
2. **Developer portal**: [dev.lulo.fi](https://dev.lulo.fi)
3. **Discord support**: [discord.gg/lulo](https://discord.gg/lulo)
4. **Telegram**: [t.me/uselulo](https://t.me/uselulo)
5. **Twitter/X**: [@uselulo](https://twitter.com/uselulo)

When reporting issues, include:
- Error message and code
- Request ID (from error response)
- Transaction signature (if applicable)
- Wallet address (public key only)
- Steps to reproduce
