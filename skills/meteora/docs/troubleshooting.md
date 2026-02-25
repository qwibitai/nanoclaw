# Meteora Troubleshooting Guide

Common issues and solutions when working with Meteora SDKs.

## Installation Issues

### Missing Dependencies

**Error**: `Cannot find module '@coral-xyz/anchor'`

**Solution**:
```bash
npm install @coral-xyz/anchor @solana/web3.js @solana/spl-token
```

### Version Conflicts

**Error**: `Conflicting peer dependency`

**Solution**:
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules
rm -rf node_modules package-lock.json

# Reinstall
npm install
```

### BigInt Support

**Error**: `BigInt is not defined`

**Solution**: Ensure Node.js >= 14 or add polyfill:
```javascript
if (typeof BigInt === 'undefined') {
  global.BigInt = require('big-integer');
}
```

---

## Connection Issues

### RPC Rate Limits

**Error**: `429 Too Many Requests`

**Solution**:
```typescript
// Use a dedicated RPC provider
const connection = new Connection('https://YOUR_RPC_ENDPOINT', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

// Or add retry logic
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Max retries reached');
}
```

### Connection Timeout

**Error**: `TransactionExpiredTimeoutError`

**Solution**:
```typescript
const connection = new Connection(endpoint, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 120000, // 2 minutes
});

// Or skip preflight for faster submission
await sendAndConfirmTransaction(connection, tx, signers, {
  skipPreflight: true,
  preflightCommitment: 'confirmed',
});
```

### WebSocket Disconnections

**Error**: `WebSocket connection closed`

**Solution**:
```typescript
// Use polling instead of WebSocket
const options = {
  commitment: 'confirmed',
  wsEndpoint: undefined, // Disable WebSocket
};

// Or implement reconnection
let wsConnection: RpcSubscriptions;

function createWsConnection() {
  wsConnection = createSolanaRpcSubscriptions(wsEndpoint);
  wsConnection.on('close', () => {
    console.log('WebSocket closed, reconnecting...');
    setTimeout(createWsConnection, 5000);
  });
}
```

---

## Transaction Errors

### Insufficient Funds

**Error**: `Attempt to debit an account but found no record of a prior credit`

**Solution**:
```typescript
// Check balance before transaction
const balance = await connection.getBalance(wallet.publicKey);
console.log('Balance:', balance / 1e9, 'SOL');

if (balance < 0.01 * 1e9) {
  throw new Error('Insufficient SOL for transaction fees');
}

// Check token balance
const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
console.log('Token balance:', tokenBalance.value.uiAmount);
```

### Slippage Exceeded

**Error**: `Slippage tolerance exceeded`

**Solution**:
```typescript
// Increase slippage tolerance
const slippageBps = 200; // 2%

// Or use fresh quote right before execution
const quote = dlmm.swapQuote(amount, direction, slippageBps, binArrays);

// Execute immediately
const swapTx = await dlmm.swap({
  ...params,
  minOutAmount: quote.minOutAmount,
});
```

### Account Not Found

**Error**: `Account does not exist`

**Solution**:
```typescript
// Check if account exists before operating
const accountInfo = await connection.getAccountInfo(address);

if (!accountInfo) {
  // Create account first
  const createTx = await createAssociatedTokenAccountInstruction(...);
}
```

### Blockhash Expired

**Error**: `Transaction simulation failed: Blockhash not found`

**Solution**:
```typescript
// Get fresh blockhash right before sending
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

transaction.recentBlockhash = blockhash;
transaction.lastValidBlockHeight = lastValidBlockHeight;

// Or use durable nonce for long-running operations
```

---

## DLMM-Specific Issues

### Position Not Found

**Error**: `Position account not found`

**Solution**:
```typescript
// Verify position exists and belongs to user
const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

const position = positions.find(p => p.publicKey.equals(positionPubkey));

if (!position) {
  console.log('Available positions:', positions.map(p => p.publicKey.toString()));
  throw new Error('Position not found');
}
```

### Invalid Bin Range

**Error**: `Invalid bin range`

**Solution**:
```typescript
// Ensure min < active < max
const activeBin = await dlmm.getActiveBin();

const minBinId = activeBin.binId - range;
const maxBinId = activeBin.binId + range;

console.log('Min:', minBinId, 'Active:', activeBin.binId, 'Max:', maxBinId);

// Verify range is valid for pool
if (minBinId < 0 || maxBinId > MAX_BIN_ID) {
  throw new Error('Bin range out of bounds');
}
```

### No Liquidity in Bins

**Error**: `Insufficient liquidity`

**Solution**:
```typescript
// Check liquidity before swap
const bins = await dlmm.getBinsAroundActiveBin(10);

for (const bin of bins) {
  console.log(`Bin ${bin.binId}: X=${bin.xAmount}, Y=${bin.yAmount}`);
}

// If no liquidity, try different direction or smaller amount
```

---

## DAMM v2-Specific Issues

### Pool Not Found

**Error**: `Pool account not found`

**Solution**:
```typescript
// Verify pool exists
const exists = await cpAmm.isPoolExist(tokenAMint, tokenBMint);

if (!exists) {
  // Pool may have tokens in reverse order
  const reverseExists = await cpAmm.isPoolExist(tokenBMint, tokenAMint);
  console.log('Reverse order exists:', reverseExists);
}
```

### Position Locked

**Error**: `Position is locked`

**Solution**:
```typescript
const positionState = await cpAmm.fetchPositionState(positionAddress);

const isLocked = cpAmm.isLockedPosition(positionState);

if (isLocked) {
  // Check vesting status
  const vestings = await cpAmm.getAllVestingsByPosition(positionAddress);

  for (const vesting of vestings) {
    console.log('Vested:', vesting.vestedAmount.toString());
    console.log('Unlocked:', vesting.unlockedAmount.toString());
  }

  // May need to refresh vesting first
  await cpAmm.refreshVesting({ owner, pool, position: positionAddress });
}
```

---

## Dynamic Bonding Curve Issues

### Pool Not Graduated

**Error**: `Pool has not graduated`

**Solution**:
```typescript
const poolState = await dbc.fetchPoolState(poolAddress);

if (!poolState.graduated) {
  console.log('Progress:', poolState.currentMarketCap.toString());
  console.log('Threshold:', poolState.graduationThreshold.toString());

  const remaining = poolState.graduationThreshold.sub(poolState.currentMarketCap);
  console.log('Remaining:', remaining.toNumber() / 1e9, 'SOL');

  // Cannot migrate until graduated
  throw new Error('Wait for graduation or use manual migrator');
}
```

### Buy/Sell Reverted

**Error**: `Swap reverted - price moved`

**Solution**:
```typescript
// Get fresh quote immediately before transaction
const quote = await dbc.getBuyQuote({ pool, quoteAmount });

// Add slippage buffer
const slippageBps = 200; // 2%
const minTokens = quote.baseAmount
  .mul(new BN(10000 - slippageBps))
  .div(new BN(10000));

// Execute quickly
const tx = await dbc.buy({ payer, pool, quoteAmount, minBaseAmount: minTokens });
```

---

## Common Patterns for Error Handling

### Retry with Backoff

```typescript
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.log(`Attempt ${attempt + 1} failed:`, error);

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError!;
}
```

### Transaction Status Checking

```typescript
async function checkTransactionStatus(
  connection: Connection,
  signature: string
): Promise<'success' | 'failed' | 'pending'> {
  const status = await connection.getSignatureStatus(signature);

  if (!status.value) {
    return 'pending';
  }

  if (status.value.err) {
    console.log('Transaction error:', status.value.err);
    return 'failed';
  }

  if (status.value.confirmationStatus === 'finalized') {
    return 'success';
  }

  return 'pending';
}
```

### Graceful Error Messages

```typescript
function parseMeteoraError(error: Error): string {
  const message = error.message;

  const errorMap: Record<string, string> = {
    'InsufficientFunds': 'Not enough tokens for this operation',
    'SlippageExceeded': 'Price moved too much - try again with higher slippage',
    'PoolNotGraduated': 'Pool has not reached graduation threshold yet',
    'PositionLocked': 'Position is locked - check vesting schedule',
    'InvalidBinRange': 'Invalid price range - adjust bin parameters',
  };

  for (const [key, friendly] of Object.entries(errorMap)) {
    if (message.includes(key)) {
      return friendly;
    }
  }

  return message;
}
```

---

## Getting Help

1. **Meteora Discord**: https://discord.gg/meteora
2. **GitHub Issues**:
   - DLMM: https://github.com/MeteoraAg/dlmm-sdk/issues
   - DAMM v2: https://github.com/MeteoraAg/cp-amm-sdk/issues
3. **Documentation**: https://docs.meteora.ag
