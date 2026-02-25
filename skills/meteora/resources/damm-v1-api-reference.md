# DAMM v1 SDK API Reference

The DAMM v1 SDK (Dynamic AMM) is Meteora's original constant product AMM, supporting standard, stable, weighted, and LST pools.

> **Note:** DAMM v2 is recommended for new pools. DAMM v1 remains fully supported for existing integrations.

## Installation

```bash
npm install @meteora-ag/dynamic-amm @solana/web3.js @coral-xyz/anchor
# or
yarn add @meteora-ag/dynamic-amm @solana/web3.js @coral-xyz/anchor
```

## Program ID

```
Mainnet/Devnet: Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
```

---

## Initialization

### Create Pool Instance

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import AmmImpl from '@meteora-ag/dynamic-amm';

const connection = new Connection('https://api.mainnet-beta.solana.com');

// Create single pool instance
const pool = await AmmImpl.create(
  connection,
  new PublicKey('POOL_ADDRESS')
);

// Create multiple pool instances
const pools = await AmmImpl.createMultiple(
  connection,
  [poolAddress1, poolAddress2, poolAddress3]
);
```

---

## Pool Creation Functions

### createPermissionlessConstantProductPoolWithConfig

Create a standard constant product pool with predefined fee configuration.

```typescript
const createPoolTx = await AmmImpl.createPermissionlessConstantProductPoolWithConfig(
  connection: Connection,
  payer: PublicKey,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  config: PublicKey,
  options?: {
    lockLiquidity?: boolean,
    activationPoint?: BN | null,
  }
);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `connection` | `Connection` | Solana RPC connection |
| `payer` | `PublicKey` | Transaction fee payer |
| `tokenAMint` | `PublicKey` | First token mint |
| `tokenBMint` | `PublicKey` | Second token mint |
| `tokenAAmount` | `BN` | Initial token A amount |
| `tokenBAmount` | `BN` | Initial token B amount |
| `config` | `PublicKey` | Fee configuration address |
| `lockLiquidity` | `boolean` | Lock initial liquidity (optional) |
| `activationPoint` | `BN \| null` | Delayed activation slot/timestamp |

---

### createPermissionlessConstantProductPoolWithConfig2

Create pool with custom activation point for delayed trading.

```typescript
const createPoolTx = await AmmImpl.createPermissionlessConstantProductPoolWithConfig2(
  connection: Connection,
  payer: PublicKey,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  config: PublicKey,
  activationType: number,  // 0 = slot, 1 = timestamp
  activationPoint: BN
);
```

---

### createPermissionlessConstantProductMemecoinPoolWithConfig

Create pool optimized for memecoin launches with locked liquidity.

```typescript
const createPoolTx = await AmmImpl.createPermissionlessConstantProductMemecoinPoolWithConfig(
  connection: Connection,
  payer: PublicKey,
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  config: PublicKey,
  options?: {
    lockLiquidity?: boolean,
  }
);
```

---

## State Query Functions

### getLpSupply

Get total LP token supply.

```typescript
const lpSupply = await pool.getLpSupply();
// Returns: BN
```

---

### getUserBalance

Get user's LP token balance.

```typescript
const balance = await pool.getUserBalance(walletAddress: PublicKey);
// Returns: BN
```

---

### getSwapQuote

Calculate expected output for a swap.

```typescript
const quote = pool.getSwapQuote(
  inputMint: PublicKey,
  inputAmount: BN,
  slippageBps: number  // 100 = 1%
);
```

**Returns:**

```typescript
{
  outAmount: BN;         // Expected output amount
  minOutAmount: BN;      // Minimum output with slippage
  fee: BN;               // Trading fee
  priceImpact: number;   // Price impact percentage
}
```

---

### getDepositQuote

Calculate LP tokens for a deposit.

```typescript
const quote = pool.getDepositQuote(
  tokenAAmount: BN,
  tokenBAmount: BN,
  isBalanced: boolean,   // true for balanced deposit
  slippageBps: number
);
```

**Returns:**

```typescript
{
  lpAmount: BN;          // LP tokens to receive
  minLpAmount: BN;       // Minimum with slippage
  tokenAUsed: BN;        // Actual token A used
  tokenBUsed: BN;        // Actual token B used
}
```

---

### getWithdrawQuote

Calculate tokens for an LP withdrawal.

```typescript
const quote = pool.getWithdrawQuote(
  lpAmount: BN,
  slippageBps: number
);
```

**Returns:**

```typescript
{
  tokenAAmount: BN;      // Token A to receive
  tokenBAmount: BN;      // Token B to receive
  minTokenAAmount: BN;   // Minimum token A with slippage
  minTokenBAmount: BN;   // Minimum token B with slippage
}
```

---

### updateState

Refresh pool state from on-chain data.

```typescript
await pool.updateState();
```

---

## Pool Operations

### deposit

Add liquidity to the pool.

```typescript
const depositTx = await pool.deposit(
  owner: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  minLpAmount: BN        // Minimum LP tokens to receive
);
```

**Example:**

```typescript
const quote = pool.getDepositQuote(
  new BN(1_000_000_000),
  new BN(1_000_000_000),
  true,
  100
);

const depositTx = await pool.deposit(
  wallet.publicKey,
  new BN(1_000_000_000),
  new BN(1_000_000_000),
  quote.minLpAmount
);

await sendAndConfirmTransaction(connection, depositTx, [wallet]);
```

---

### withdraw

Remove liquidity from the pool.

```typescript
const withdrawTx = await pool.withdraw(
  owner: PublicKey,
  lpAmount: BN,
  tokenAMin: BN,         // Minimum token A to receive
  tokenBMin: BN          // Minimum token B to receive
);
```

**Example:**

```typescript
const lpBalance = await pool.getUserBalance(wallet.publicKey);
const quote = pool.getWithdrawQuote(lpBalance, 100);

const withdrawTx = await pool.withdraw(
  wallet.publicKey,
  lpBalance,
  quote.minTokenAAmount,
  quote.minTokenBAmount
);

await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
```

---

### swap

Execute a token swap.

```typescript
const swapTx = await pool.swap(
  owner: PublicKey,
  inputMint: PublicKey,
  inputAmount: BN,
  minOutputAmount: BN
);
```

**Example:**

```typescript
const quote = pool.getSwapQuote(
  tokenAMint,
  new BN(1_000_000_000),
  100  // 1% slippage
);

const swapTx = await pool.swap(
  wallet.publicKey,
  tokenAMint,
  new BN(1_000_000_000),
  quote.minOutAmount
);

await sendAndConfirmTransaction(connection, swapTx, [wallet]);
```

---

## Pool Types

### Constant Product Pools

Standard AMM pools using the x * y = k formula.

```typescript
// Best for: General trading pairs
// Slippage: Normal for large trades
// Use case: Most token pairs
```

### Stable Pools

Optimized for pegged asset pairs with lower slippage.

```typescript
// Best for: Stablecoin pairs (USDC/USDT)
// Slippage: Very low near peg
// Use case: Pegged assets, wrapped tokens
```

### Weighted Pools

Pools with custom token weight ratios.

```typescript
// Best for: Unbalanced exposure (80/20)
// Slippage: Depends on weights
// Use case: Index funds, LBPs
```

### LST Pools

Optimized for liquid staking token pairs.

```typescript
// Best for: mSOL/SOL, stSOL/SOL
// Slippage: Optimized for staking derivatives
// Use case: LST trading and arbitrage
```

---

## Complete Example

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import AmmImpl from '@meteora-ag/dynamic-amm';
import BN from 'bn.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.fromSecretKey(/* your key */);

async function main() {
  // Initialize pool
  const poolAddress = new PublicKey('YOUR_POOL_ADDRESS');
  const pool = await AmmImpl.create(connection, poolAddress);

  // Get pool info
  const lpSupply = await pool.getLpSupply();
  console.log('LP Supply:', lpSupply.toString());

  // Get swap quote
  const tokenAMint = pool.tokenAMint;
  const swapQuote = pool.getSwapQuote(
    tokenAMint,
    new BN(1_000_000_000),
    100
  );

  console.log('Swap Output:', swapQuote.outAmount.toString());
  console.log('Price Impact:', swapQuote.priceImpact, '%');

  // Execute swap
  const swapTx = await pool.swap(
    wallet.publicKey,
    tokenAMint,
    new BN(1_000_000_000),
    swapQuote.minOutAmount
  );

  const txId = await sendAndConfirmTransaction(connection, swapTx, [wallet]);
  console.log('Swap complete:', txId);
}

main().catch(console.error);
```

---

## Error Handling

```typescript
try {
  const swapTx = await pool.swap(params);
  await sendAndConfirmTransaction(connection, swapTx, [wallet]);
} catch (error) {
  if (error.message.includes('SlippageExceeded')) {
    console.error('Price moved beyond slippage tolerance');
  } else if (error.message.includes('InsufficientBalance')) {
    console.error('Not enough tokens for swap');
  } else if (error.message.includes('PoolNotActive')) {
    console.error('Pool is not active yet');
  } else {
    throw error;
  }
}
```

---

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `SlippageExceeded` | Price moved beyond tolerance | Increase slippageBps |
| `InsufficientBalance` | Not enough tokens | Check wallet balance |
| `PoolNotActive` | Pool has delayed activation | Wait for activation point |
| `InvalidMint` | Wrong token mint | Verify token addresses |
| `ZeroLiquidity` | Pool has no liquidity | Pool needs initial deposit |

---

## Migration to DAMM v2

For new pools, consider using DAMM v2:

| Feature | DAMM v1 | DAMM v2 |
|---------|---------|---------|
| LP Representation | LP Token | Position NFT |
| Token-2022 | Limited | Full Support |
| Dynamic Fees | No | Yes (scheduler) |
| Pool Cost | ~0.15 SOL | 0.022 SOL |
| Farms | Separate SDK | Built-in |

---

## Related Resources

- [DAMM v1 SDK GitHub](https://github.com/MeteoraAg/damm-v1-sdk)
- [Meteora App](https://app.meteora.ag/#dynamicpools)
- [Meteora Documentation](https://docs.meteora.ag)
