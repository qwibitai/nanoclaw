# Orca Whirlpools Troubleshooting Guide

Common issues and solutions when working with the Orca Whirlpools SDK.

---

## SDK Version Compatibility

### "Cannot find module '@solana/kit'"

**Problem**: The new SDK (`@orca-so/whirlpools`) requires Solana Web3.js v2 and `@solana/kit`.

**Solution**:

```bash
# For new SDK (Web3.js v2)
npm install @orca-so/whirlpools @solana/kit

# For legacy SDK (Web3.js v1)
npm install @orca-so/whirlpools-sdk @solana/web3.js @coral-xyz/anchor@0.29.0
```

**Note**: The new SDK is NOT compatible with Web3.js v1.x.x. If your project uses v1, use the legacy SDK.

---

### "Module '@solana/web3.js' has incompatible version"

**Problem**: Mixing v1 and v2 Solana packages.

**Solution**: Check your package.json and ensure consistency:

```bash
# Check installed versions
npm ls @solana/web3.js

# For v2 (new SDK)
npm install @solana/kit @solana/web3.js@2

# For v1 (legacy SDK)
npm install @solana/web3.js@1 @coral-xyz/anchor@0.29.0
```

---

## Connection Errors

### "Failed to connect to RPC"

**Problem**: Cannot establish connection to Solana RPC endpoint.

**Solutions**:

1. Verify RPC URL format:
```typescript
await setRpc("https://api.mainnet-beta.solana.com");
```

2. Try alternative RPC providers:
```typescript
// Free public RPCs (rate limited)
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEVNET_RPC = "https://api.devnet.solana.com";

// Dedicated providers (recommended for production)
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const QUICKNODE_RPC = `https://your-endpoint.solana-mainnet.quiknode.pro/${API_KEY}`;
```

3. Check network connectivity and firewall settings

---

### "429 Too Many Requests"

**Problem**: Rate limited by RPC provider.

**Solutions**:

1. Use a dedicated RPC provider (Helius, QuickNode, Triton, etc.)
2. Add retry logic with exponential backoff:

```typescript
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## Swap Errors

### "SlippageExceeded"

**Problem**: Price moved beyond slippage tolerance during swap.

**Solutions**:

1. Increase slippage tolerance:
```typescript
const slippageBps = 200; // 2% instead of 1%

const txId = await swap(rpc, params, poolAddress, slippageBps, wallet);
```

2. Reduce swap amount for large trades:
```typescript
// Split large swaps into smaller chunks
const chunkSize = totalAmount / 4n;
for (let i = 0; i < 4; i++) {
  await swap(rpc, { inputAmount: chunkSize, mint }, pool, slippage, wallet);
}
```

3. Use priority fees for faster execution:
```typescript
await setPriorityFeeSetting({ type: "dynamic", percentile: 90 });
```

---

### "ZeroTradableAmount"

**Problem**: Swap amount is too small to trade.

**Solutions**:

1. Increase the swap amount
2. Check token decimals (e.g., USDC has 6 decimals, SOL has 9):
```typescript
// 1 USDC = 1_000_000 (6 decimals)
// 1 SOL = 1_000_000_000 (9 decimals)
const amount = 1_000_000n; // 1 USDC, not 1 unit
```

---

### "InsufficientFunds"

**Problem**: Not enough tokens in wallet.

**Solutions**:

1. Check wallet balance:
```typescript
const balance = await rpc.getBalance(walletAddress).send();
console.log("SOL balance:", balance.value / 1e9);
```

2. Include fees in calculations:
```typescript
const txFee = 5000n; // ~0.000005 SOL
const swapAmount = balance - txFee - 10000n; // Leave buffer
```

---

## Position Errors

### "InvalidTickIndex"

**Problem**: Price range tick indices are invalid for the pool.

**Solutions**:

1. Ensure tick indices are divisible by tick spacing:
```typescript
// For tick spacing 64, valid ticks: -128, -64, 0, 64, 128, etc.
const tickSpacing = 64;
const lowerTick = Math.floor(desiredTick / tickSpacing) * tickSpacing;
```

2. Use price instead of raw ticks:
```typescript
const { positionMint } = await openPositionInstructions(
  rpc,
  poolAddress,
  param,
  0.8 * currentPrice,  // 20% below
  1.2 * currentPrice,  // 20% above
  slippage,
  wallet
);
```

---

### "TickArrayNotInitialized"

**Problem**: Tick arrays for the price range haven't been initialized.

**Solutions**:

1. Use a price range closer to current price
2. The SDK should initialize tick arrays automatically - ensure you're using the latest version
3. For manual initialization (advanced):
```typescript
// Initialize tick array before opening position
// This is typically handled by the SDK
```

---

### "ClosePositionNotEmpty"

**Problem**: Trying to close a position that still has liquidity.

**Solution**: First decrease all liquidity:
```typescript
// Get position data to find liquidity amount
const positions = await fetchPositionsForOwner(rpc, walletAddress);
const position = positions.find(p => p.positionMint === positionMint);

// Decrease all liquidity
await decreaseLiquidity(
  rpc,
  positionMint,
  { liquidity: position.liquidity },
  slippage,
  wallet
);

// Now close
await closePosition(rpc, positionMint, slippage, wallet);
```

---

### "Position out of range"

**Problem**: Current price is outside your position's range, so you're not earning fees.

**Solutions**:

1. Monitor position and rebalance when needed:
```typescript
const pool = await fetchConcentratedLiquidityPool(rpc, poolAddress);
const position = await fetchPositionsForOwner(rpc, walletAddress);

const isInRange = pool.tickCurrentIndex >= position.tickLowerIndex &&
                  pool.tickCurrentIndex < position.tickUpperIndex;

if (!isInRange) {
  console.log("Position is out of range - consider rebalancing");
}
```

2. Use wider price ranges for less maintenance
3. Close and reopen position with new range

---

## Pool Errors

### "InvalidTokenMintOrder"

**Problem**: Token mints are not in the correct order.

**Solution**: Use `orderMints` function:
```typescript
import { orderMints } from "@orca-so/whirlpools";

const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);
const pool = await createConcentratedLiquidityPoolInstructions(
  rpc,
  orderedA,  // Use ordered mints
  orderedB,
  tickSpacing,
  initialPrice,
  wallet
);
```

---

### "PoolAlreadyExists"

**Problem**: Pool with same configuration already exists.

**Solution**: Check existing pools first:
```typescript
const existingPools = await fetchWhirlpoolsByTokenPair(rpc, tokenA, tokenB);

const poolWithSameSpacing = existingPools.find(
  p => p.tickSpacing === desiredTickSpacing
);

if (poolWithSameSpacing) {
  console.log("Pool exists:", poolWithSameSpacing.address);
} else {
  // Create new pool
}
```

---

### "InvalidTickSpacing"

**Problem**: Using unsupported tick spacing value.

**Solution**: Use only valid tick spacing values:

| Tick Spacing | Fee Tier | Use Case |
|--------------|----------|----------|
| 1 | 0.01% | Stablecoins |
| 8 | 0.04% | Correlated pairs |
| 64 | 0.30% | Standard pairs |
| 128 | 1.00% | Volatile pairs |

```typescript
// Valid values only
const tickSpacing: 1 | 8 | 64 | 128 = 64;
```

---

## Transaction Errors

### "Transaction simulation failed"

**Problem**: Transaction fails during simulation.

**Solutions**:

1. Get simulation logs:
```typescript
try {
  const txId = await swap(rpc, params, pool, slippage, wallet);
} catch (error) {
  console.log("Error:", error.message);
  console.log("Logs:", error.logs); // If available
}
```

2. Check all account requirements are met
3. Verify sufficient compute units

---

### "Blockhash expired"

**Problem**: Transaction took too long to confirm.

**Solutions**:

1. Use priority fees:
```typescript
await setPriorityFeeSetting({ type: "dynamic", percentile: 75 });
```

2. Use Jito for MEV protection:
```typescript
await setJitoTipSetting({ type: "dynamic", percentile: 50 });
```

3. Retry with fresh blockhash (SDK handles this automatically)

---

### "Transaction too large"

**Problem**: Transaction exceeds size limits.

**Solutions**:

1. Use Address Lookup Tables (ALTs)
2. Split into multiple transactions
3. Reduce number of positions being modified at once

---

## Wallet Errors

### "Wallet file not found"

**Problem**: Cannot find keypair file.

**Solutions**:

1. Verify file path:
```typescript
import * as fs from "fs";
import * as path from "path";

const walletPath = path.resolve("./keypair.json");
console.log("Looking for:", walletPath);
console.log("Exists:", fs.existsSync(walletPath));
```

2. Generate new keypair if needed:
```bash
solana-keygen new -o keypair.json
```

---

### "Invalid keypair format"

**Problem**: Keypair file is malformed.

**Solution**: Verify format (should be JSON array of 64 numbers):
```typescript
const data = JSON.parse(fs.readFileSync("keypair.json", "utf8"));
console.log("Type:", typeof data);
console.log("Length:", data.length); // Should be 64
console.log("First byte:", data[0]); // Should be a number
```

---

## Environment Issues

### "TypeScript errors with SDK types"

**Problem**: Type mismatches when using SDK.

**Solutions**:

1. Ensure correct TypeScript config:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "resolveJsonModule": true
  }
}
```

2. Install type definitions:
```bash
npm install -D typescript @types/node
```

---

### "Module resolution issues"

**Problem**: Cannot resolve SDK modules.

**Solutions**:

1. Clear and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

2. Check Node.js version (require 18+):
```bash
node --version
```

---

## Debugging Tips

### Enable Verbose Logging

```typescript
// Log all transaction details
const { instructions, quote } = await swapInstructions(
  rpc,
  params,
  pool,
  slippage,
  wallet
);

console.log("Instructions:", instructions.length);
console.log("Quote:", JSON.stringify(quote, (_, v) =>
  typeof v === "bigint" ? v.toString() : v
, 2));
```

### Check Account State

```typescript
// Verify position exists and is owned by wallet
const positions = await fetchPositionsForOwner(rpc, walletAddress);
const myPosition = positions.find(p => p.positionMint === targetMint);

if (!myPosition) {
  console.log("Position not found or not owned by this wallet");
}
```

### Verify Pool State

```typescript
const pool = await fetchConcentratedLiquidityPool(rpc, poolAddress);
console.log("Pool state:");
console.log("  Current tick:", pool.tickCurrentIndex);
console.log("  Price:", pool.price);
console.log("  Liquidity:", pool.liquidity.toString());
console.log("  Fee rate:", pool.feeRate);
```

---

## Getting Help

1. **Check documentation**: [dev.orca.so](https://dev.orca.so/)
2. **GitHub Issues**: [orca-so/whirlpools](https://github.com/orca-so/whirlpools/issues)
3. **Discord**: Join the Orca Discord for community support
4. **Verify on Devnet**: Test all operations on devnet before mainnet
