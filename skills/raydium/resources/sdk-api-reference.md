# Raydium SDK API Reference

Complete API reference for `@raydium-io/raydium-sdk-v2`.

## Installation

```bash
yarn add @raydium-io/raydium-sdk-v2
```

## SDK Initialization

```typescript
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';

const raydium = await Raydium.load({
  connection: Connection,
  owner: Keypair,
  cluster: 'mainnet' | 'devnet',
  disableLoadToken?: boolean,  // Skip loading token list
  signAllTransactions?: Function,
});
```

## Token Access

```typescript
// Token list array
raydium.token.tokenList: TokenInfo[]

// Token map by mint address
raydium.token.tokenMap: Map<string, TokenInfo>

// Mint groups
raydium.token.mintGroup: MintGroup
```

## Account Access

```typescript
// Token accounts
raydium.account.tokenAccounts: TokenAccount[]

// Raw token account info
raydium.account.tokenAccountRawInfos: TokenAccountRawInfo[]

// Update token accounts manually
await raydium.account.updateTokenAccount()
```

---

## API Methods

### Token API

```typescript
// Get default mint list
await raydium.api.getTokenList()

// Get token info by mints
await raydium.api.getTokenInfo(mints: string[])
```

### Pool API

```typescript
// Fetch pool by ID
await raydium.api.fetchPoolById({
  ids: string | string[]
})

// Fetch pools by mints
await raydium.api.fetchPoolByMints({
  mint1: string,
  mint2: string,
  type?: 'all' | 'clmm' | 'cpmm' | 'amm',
})

// Get pool list
await raydium.api.getPoolList({
  type?: string,
  sort?: string,
  order?: 'asc' | 'desc',
  pageSize?: number,
  page?: number,
})
```

### Farm API

```typescript
// Get farm info
await raydium.api.getFarmInfo({
  ids: string[]
})

// Get farm list
await raydium.api.getFarmList()
```

---

## CLMM Module

### Pool Operations

```typescript
// Fetch pool info from RPC
await raydium.clmm.getPoolInfoFromRpc(poolId: string)

// Create CLMM pool
await raydium.clmm.createPool({
  mint1: ApiV3Token,
  mint2: ApiV3Token,
  ammConfig: AmmConfigItem,
  initialPrice: Decimal,
  txVersion?: TxVersion,
  computeBudgetConfig?: ComputeBudgetConfig,
})
```

### Position Operations

```typescript
// Open position from base amount
await raydium.clmm.openPositionFromBase({
  poolInfo: ApiV3PoolInfoConcentratedItem,
  tickLower: number,
  tickUpper: number,
  base: 'MintA' | 'MintB',
  baseAmount: BN,
  otherAmountMax: BN,
  txVersion?: TxVersion,
})

// Open position from liquidity
await raydium.clmm.openPositionFromLiquidity({
  poolInfo,
  tickLower: number,
  tickUpper: number,
  liquidity: BN,
  amountMaxA: BN,
  amountMaxB: BN,
})

// Increase liquidity
await raydium.clmm.increasePositionFromBase({
  poolInfo,
  ownerPosition: ClmmPositionLayout,
  base: 'MintA' | 'MintB',
  baseAmount: BN,
  otherAmountMax: BN,
})

// Decrease liquidity
await raydium.clmm.decreaseLiquidity({
  poolInfo,
  ownerPosition: ClmmPositionLayout,
  liquidity: BN,
  amountMinA: BN,
  amountMinB: BN,
})

// Close position
await raydium.clmm.closePosition({
  poolInfo,
  ownerPosition: ClmmPositionLayout,
})
```

### Swap

```typescript
await raydium.clmm.swap({
  poolInfo: ApiV3PoolInfoConcentratedItem,
  inputMint: string,
  amountIn: BN,
  amountOutMin: BN,
  observationId?: PublicKey,
  txVersion?: TxVersion,
})
```

### Farm Operations

```typescript
// Create farm
await raydium.clmm.createFarm({
  poolInfo,
  rewardInfos: RewardInfo[],
})

// Harvest rewards
await raydium.clmm.harvestAllRewards({
  allPoolInfo: PoolInfo[],
  allPositions: Position[],
})
```

---

## CPMM Module

### Pool Operations

```typescript
// Get pool info from RPC
await raydium.cpmm.getPoolInfoFromRpc(poolId: string)

// Create pool
await raydium.cpmm.createPool({
  mintA: ApiV3Token,
  mintB: ApiV3Token,
  mintAAmount: BN,
  mintBAmount: BN,
  startTime: BN,
  feeConfig: CpmmConfigInfo,
  txVersion?: TxVersion,
})
```

### Liquidity Operations

```typescript
// Add liquidity
await raydium.cpmm.addLiquidity({
  poolInfo: ApiV3PoolInfoStandardItemCpmm,
  inputAmount: BN,
  baseIn: boolean,  // true = inputAmount is for mintA
  slippage: number,
  txVersion?: TxVersion,
})

// Remove liquidity
await raydium.cpmm.withdrawLiquidity({
  poolInfo,
  lpAmount: BN,
  slippage: number,
})
```

### Swap

```typescript
await raydium.cpmm.swap({
  poolInfo: ApiV3PoolInfoStandardItemCpmm,
  inputAmount: BN,
  inputMint: string,
  slippage: number,
  txVersion?: TxVersion,
  computeBudgetConfig?: ComputeBudgetConfig,
})
```

### Lock Liquidity

```typescript
// Lock LP tokens
await raydium.cpmm.lockLiquidity({
  poolInfo,
  lpAmount: BN,
})

// Harvest from locked
await raydium.cpmm.harvestLockLiquidity({
  poolInfo,
  lockInfo: LockInfo,
})
```

---

## AMM Module

### Pool Operations

```typescript
// Get pool info
await raydium.liquidity.getPoolInfoFromRpc({
  poolId: string,
})

// Create pool (requires OpenBook market)
await raydium.liquidity.createPoolV4({
  marketInfo: MarketInfo,
  baseMintInfo: MintInfo,
  quoteMintInfo: MintInfo,
  baseAmount: BN,
  quoteAmount: BN,
  startTime: BN,
})
```

### Liquidity

```typescript
// Add liquidity
await raydium.liquidity.addLiquidity({
  poolInfo,
  amountInA: BN,
  amountInB: BN,
  fixedSide: 'a' | 'b',
})

// Remove liquidity
await raydium.liquidity.removeLiquidity({
  poolInfo,
  lpAmount: BN,
})
```

### Swap

```typescript
await raydium.liquidity.swap({
  poolInfo,
  amountIn: BN,
  amountOut: BN,
  inputMint: string,
  fixedSide: 'in' | 'out',
})
```

---

## Utility Functions

### Curve Calculator

```typescript
import { CurveCalculator } from '@raydium-io/raydium-sdk-v2';

// Calculate swap output
const { amountOut, fee } = CurveCalculator.swapBaseInput({
  poolInfo,
  amountIn: BN,
  mintIn: string,
  mintOut: string,
});

// Calculate swap input for desired output
const { amountIn, fee } = CurveCalculator.swapBaseOutput({
  poolInfo,
  amountOut: BN,
  mintIn: string,
  mintOut: string,
});
```

### Tick Utils (CLMM)

```typescript
import { TickUtils } from '@raydium-io/raydium-sdk-v2';

// Get price and tick from price
const { tick, price } = TickUtils.getPriceAndTick({
  poolInfo,
  price: Decimal,
  baseIn: boolean,
});

// Get tick from price
const tick = TickUtils.getTickFromPrice({
  poolInfo,
  price: Decimal,
});
```

### Pool Utils

```typescript
import { PoolUtils } from '@raydium-io/raydium-sdk-v2';

// Calculate liquidity from amounts
const liquidity = PoolUtils.getLiquidityAmountOutFromAmountIn({
  poolInfo,
  tickLower: number,
  tickUpper: number,
  amount: BN,
  slippage: number,
  add: boolean,
  amountHasFee: boolean,
});
```

---

## Transaction Execution

All build methods return an execute function:

```typescript
const { execute, transaction, signers } = await raydium.cpmm.swap({...});

// Execute with options
const { txId, signedTx } = await execute({
  sendAndConfirm: boolean,
  skipPreflight?: boolean,
  preflightCommitment?: Commitment,
});

// Or get transaction for manual handling
const tx = transaction;
const txSigners = signers;
```

## Compute Budget Config

```typescript
const computeBudgetConfig = {
  units: 600000,           // Compute units
  microLamports: 100000,   // Priority fee in microlamports
};

await raydium.cpmm.swap({
  ...params,
  computeBudgetConfig,
});
```
