# Raydium Troubleshooting Guide

Common issues and solutions when working with Raydium SDK.

## SDK Initialization Issues

### "Failed to load token list"

**Cause:** API rate limiting or network issues

**Solution:**
```typescript
// Disable token loading if not needed
const raydium = await Raydium.load({
  connection,
  owner,
  cluster: 'mainnet',
  disableLoadToken: true, // Skip token list
});

// Manually load tokens when needed
await raydium.token.load();
```

### "Connection refused" or Timeout

**Cause:** RPC endpoint issues

**Solution:**
```typescript
// Use a reliable RPC provider
const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=YOUR_KEY', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

// Or retry logic
async function initWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await Raydium.load({ connection, owner, cluster: 'mainnet' });
    } catch (e) {
      console.log(`Retry ${i + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Failed to initialize SDK');
}
```

---

## Transaction Failures

### "Insufficient funds"

**Cause:** Not enough SOL or tokens

**Solution:**
```typescript
// Check balance before transaction
const solBalance = await connection.getBalance(owner.publicKey);
const requiredSol = 0.01 * 1e9; // 0.01 SOL for fees

if (solBalance < requiredSol) {
  throw new Error(`Need at least ${requiredSol / 1e9} SOL`);
}

// Check token balance
const tokenAccount = await raydium.account.getTokenAccount(tokenMint);
if (!tokenAccount || tokenAccount.amount < requiredAmount) {
  throw new Error('Insufficient token balance');
}
```

### "Slippage exceeded"

**Cause:** Price moved during transaction

**Solution:**
```typescript
// Increase slippage tolerance
const { execute } = await raydium.cpmm.swap({
  poolInfo,
  inputAmount,
  inputMint,
  slippage: 0.03, // Increase from 1% to 3%
  txVersion: 'V0',
});

// Or use compute budget for faster execution
const { execute } = await raydium.cpmm.swap({
  poolInfo,
  inputAmount,
  inputMint,
  slippage: 0.01,
  computeBudgetConfig: {
    units: 600000,
    microLamports: 200000, // Higher priority fee
  },
});
```

### "Transaction simulation failed"

**Cause:** Various - check logs for details

**Solution:**
```typescript
try {
  const { execute } = await raydium.cpmm.swap({...});

  // Execute with skipPreflight to see actual error
  const { txId } = await execute({
    sendAndConfirm: true,
    skipPreflight: true, // Skip simulation
  });
} catch (error: any) {
  // Parse error logs
  if (error.logs) {
    console.log('Transaction logs:', error.logs);
  }

  // Check specific errors
  if (error.message.includes('0x1')) {
    console.error('Insufficient funds');
  } else if (error.message.includes('0x11')) {
    console.error('Slippage exceeded');
  }
}
```

### "Blockhash expired"

**Cause:** Transaction took too long to confirm

**Solution:**
```typescript
// Get fresh blockhash
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

// Use durable nonce for long-running transactions
// Or increase timeout
const { execute, transaction } = await raydium.cpmm.swap({...});

// Manual send with retry
const signature = await connection.sendTransaction(transaction, [owner], {
  maxRetries: 5,
  skipPreflight: true,
});

await connection.confirmTransaction({
  signature,
  blockhash,
  lastValidBlockHeight,
});
```

---

## Pool Issues

### "Pool not found"

**Cause:** Wrong pool ID or pool doesn't exist

**Solution:**
```typescript
// Verify pool exists
try {
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  console.log('Pool found:', poolInfo.id);
} catch (e) {
  // Try API
  const pools = await raydium.api.fetchPoolById({ ids: poolId });
  if (pools.length === 0) {
    console.error('Pool does not exist');
  }
}

// Search by token mints
const pools = await raydium.api.fetchPoolByMints({
  mint1: tokenA,
  mint2: tokenB,
  type: 'all',
});

console.log('Available pools:', pools.map(p => ({
  id: p.id,
  type: p.type,
  tvl: p.tvl,
})));
```

### "Wrong pool type"

**Cause:** Using CLMM method on CPMM pool or vice versa

**Solution:**
```typescript
// Check pool type first
const poolData = await raydium.api.fetchPoolById({ ids: poolId });
const poolType = poolData[0].type;

if (poolType === 'Concentrated') {
  // Use CLMM methods
  await raydium.clmm.swap({...});
} else if (poolType === 'Standard') {
  // Check if CPMM or AMM
  if (poolData[0].programId === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C') {
    await raydium.cpmm.swap({...});
  } else {
    await raydium.liquidity.swap({...});
  }
}
```

---

## CLMM-Specific Issues

### "Tick out of range"

**Cause:** Invalid tick value for the pool's tick spacing

**Solution:**
```typescript
import { TickUtils } from '@raydium-io/raydium-sdk-v2';

// Get valid tick
const tickSpacing = poolInfo.config.tickSpacing;
const validTick = TickUtils.getNearestValidTick({
  tick: desiredTick,
  tickSpacing,
});

// Or use price-based calculation
const { tick } = TickUtils.getPriceAndTick({
  poolInfo,
  price: new Decimal(targetPrice),
  baseIn: true,
});
```

### "Position not found"

**Cause:** Wrong NFT mint or position closed

**Solution:**
```typescript
// List all positions
const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });

console.log('Your positions:');
positions.forEach((pos, i) => {
  console.log(`${i + 1}. NFT: ${pos.nftMint.toBase58()}`);
  console.log(`   Liquidity: ${pos.liquidity.toString()}`);
  console.log(`   Range: ${pos.tickLower} - ${pos.tickUpper}`);
});

// Find by NFT
const position = positions.find(p => p.nftMint.toBase58() === nftMint);
if (!position) {
  console.error('Position not found - may have been closed');
}
```

### "Cannot decrease liquidity - position empty"

**Cause:** Trying to remove more than available

**Solution:**
```typescript
// Check available liquidity
const position = positions.find(p => p.nftMint.toBase58() === nftMint);

if (position.liquidity.isZero()) {
  console.log('Position has no liquidity - only fees can be harvested');

  // Harvest fees only
  await raydium.clmm.decreaseLiquidity({
    poolInfo,
    ownerPosition: position,
    liquidity: new BN(0),
    amountMinA: new BN(0),
    amountMinB: new BN(0),
  });
}
```

---

## API Issues

### "Rate limited"

**Cause:** Too many API requests

**Solution:**
```typescript
// Add delay between requests
async function fetchWithDelay<T>(
  fetcher: () => Promise<T>,
  delayMs = 500
): Promise<T> {
  await new Promise(r => setTimeout(r, delayMs));
  return fetcher();
}

// Or use RPC instead of API
const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
// Instead of: await raydium.api.fetchPoolById({ ids: poolId });
```

### "API unavailable" (Devnet)

**Cause:** Limited API support on devnet

**Solution:**
```typescript
// Use RPC methods on devnet
if (cluster === 'devnet') {
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
} else {
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
}
```

---

## Performance Optimization

### Slow Transactions

```typescript
// 1. Use higher priority fees
const computeBudgetConfig = {
  units: 600000,
  microLamports: 100000, // Increase during congestion
};

// 2. Use V0 transactions
txVersion: 'V0', // More efficient than LEGACY

// 3. Skip preflight when confident
await execute({
  sendAndConfirm: true,
  skipPreflight: true,
});
```

### High Memory Usage

```typescript
// Disable token loading if not needed
const raydium = await Raydium.load({
  connection,
  owner,
  cluster: 'mainnet',
  disableLoadToken: true,
});

// Fetch only needed data
const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
// Instead of loading all pools
```

---

## Getting Help

1. **SDK Issues**: https://github.com/raydium-io/raydium-sdk-V2/issues
2. **Discord**: Join Raydium Discord for community support
3. **Documentation**: https://docs.raydium.io
4. **Examples**: https://github.com/raydium-io/raydium-sdk-V2-demo
