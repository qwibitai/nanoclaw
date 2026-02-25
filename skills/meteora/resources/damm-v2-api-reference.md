# DAMM v2 SDK API Reference

Complete API reference for the `@meteora-ag/cp-amm-sdk` package.

## Installation

```bash
npm install @meteora-ag/cp-amm-sdk @solana/web3.js
```

## CpAmm Class

### Constructor

```typescript
const cpAmm = new CpAmm(connection: Connection);
```

### Pool Management Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `createPool(params)` | Create standard pool | `CreatePoolParams` | `TxBuilder` |
| `createCustomPool(params)` | Create pool with custom settings | `CreateCustomPoolParams` | `TxBuilder` |
| `createCustomPoolWithDynamicConfig(params)` | Create pool with dynamic config | `CreateCustomPoolWithDynamicConfigParams` | `TxBuilder` |
| `fetchPoolState(address)` | Fetch single pool state | `PublicKey` | `Promise<PoolState>` |
| `fetchConfigState(address)` | Fetch pool config | `PublicKey` | `Promise<ConfigState>` |
| `getAllPools()` | Fetch all DAMM v2 pools | - | `Promise<PoolState[]>` |
| `isPoolExist(tokenA, tokenB)` | Check if pool exists | `PublicKey`, `PublicKey` | `Promise<boolean>` |

### Position Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `createPosition(params)` | Create new position | `CreatePositionParams` | `TxBuilder` |
| `addLiquidity(params)` | Add liquidity to position | `AddLiquidityParams` | `TxBuilder` |
| `removeLiquidity(params)` | Remove liquidity | `RemoveLiquidityParams` | `TxBuilder` |
| `mergePosition(params)` | Merge multiple positions | `MergePositionParams` | `TxBuilder` |
| `splitPosition(params)` | Split by percentage | `SplitPositionParams` | `TxBuilder` |
| `splitPosition2(params)` | Split by numerator | `SplitPosition2Params` | `TxBuilder` |
| `fetchPositionState(address)` | Fetch position state | `PublicKey` | `Promise<PositionState>` |
| `getAllPositions()` | Fetch all positions | - | `Promise<PositionState[]>` |
| `getPositionsByUser(user)` | Get user's positions | `PublicKey` | `Promise<PositionState[]>` |
| `getUserPositionByPool(user, pool)` | Get user positions in pool | `PublicKey`, `PublicKey` | `Promise<PositionState[]>` |
| `isLockedPosition(position)` | Check if position is locked | `PositionState` | `boolean` |

### Trading Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `swap(params)` | Execute swap | `SwapParams` | `TxBuilder` |
| `swap2(params)` | Swap with additional options | `Swap2Params` | `TxBuilder` |
| `getQuote(params)` | Get swap quote | `GetQuoteParams` | `QuoteResult` |
| `getQuote2(params)` | Get quote with more options | `GetQuote2Params` | `QuoteResult` |

### Liquidity Quote Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getDepositQuote(params)` | Calculate deposit requirements | `DepositQuoteParams` | `DepositQuote` |
| `getWithdrawQuote(params)` | Calculate withdrawal amounts | `WithdrawQuoteParams` | `WithdrawQuote` |
| `getLiquidityDelta(params)` | Calculate liquidity from amounts | `LiquidityDeltaParams` | `BN` |

### Vesting & Locking Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `lockPosition(params)` | Create vesting schedule | `LockPositionParams` | `TxBuilder` |
| `permanentLockPosition(params)` | Permanently lock liquidity | `PermanentLockParams` | `TxBuilder` |
| `refreshVesting(params)` | Unlock available tokens | `RefreshVestingParams` | `TxBuilder` |
| `getAllVestingsByPosition(position)` | Get all vestings | `PublicKey` | `Promise<VestingState[]>` |

### Fee & Reward Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `claimPositionFee(params)` | Claim trading fees | `ClaimFeeParams` | `TxBuilder` |
| `claimPositionFee2(params)` | Claim with more options | `ClaimFee2Params` | `TxBuilder` |
| `initializeReward(params)` | Initialize reward distribution | `InitRewardParams` | `TxBuilder` |
| `fundReward(params)` | Fund reward pool | `FundRewardParams` | `TxBuilder` |
| `claimReward(params)` | Claim earned rewards | `ClaimRewardParams` | `TxBuilder` |

### Helper Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getPriceFromSqrtPrice(sqrtPrice, decA, decB)` | Convert sqrt to price | `BN`, `number`, `number` | `Decimal` |
| `getSqrtPriceFromPrice(price, decA, decB)` | Convert price to sqrt | `Decimal`, `number`, `number` | `BN` |
| `getBaseFeeNumerator(config, point)` | Calculate base fee | `FeeConfig`, `BN` | `BN` |
| `getDynamicFeeNumerator(config, volatility)` | Calculate dynamic fee | `DynamicFeeConfig`, `BN` | `BN` |
| `bpsToFeeNumerator(bps)` | Convert bps to numerator | `number` | `BN` |
| `feeNumeratorToBps(numerator)` | Convert numerator to bps | `BN` | `number` |
| `getAmountWithSlippage(amount, slippage, isMin)` | Calculate with slippage | `BN`, `number`, `boolean` | `BN` |
| `getMaxAmountWithSlippage(amount, slippage)` | Calculate max with slippage | `BN`, `number` | `BN` |
| `getPriceImpact(in, out, price)` | Calculate price impact | `BN`, `BN`, `Decimal` | `Decimal` |

## Types

### PoolState

```typescript
interface PoolState {
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  sqrtPrice: BN;
  liquidity: BN;
  feeGrowthGlobalA: BN;
  feeGrowthGlobalB: BN;
  protocolFeeA: BN;
  protocolFeeB: BN;
  rewardInfos: RewardInfo[];
  activationType: number;      // 0 = slot, 1 = timestamp
  activationPoint: BN;
  collectFeeMode: number;
  poolFees: PoolFees;
}
```

### PositionState

```typescript
interface PositionState {
  owner: PublicKey;
  pool: PublicKey;
  liquidity: BN;
  unlockedLiquidity: BN;
  vestedLiquidity: BN;
  permanentLockedLiquidity: BN;
  feeOwedA: BN;
  feeOwedB: BN;
  feeGrowthInsideLastA: BN;
  feeGrowthInsideLastB: BN;
  rewardInfos: PositionRewardInfo[];
}
```

### PoolFees

```typescript
interface PoolFees {
  baseFee: BaseFeeConfig;
  dynamicFee: DynamicFeeConfig | null;
  protocolFeePercent: number;
  partnerFeePercent: number;
  referralFeePercent: number;
}

interface BaseFeeConfig {
  cliffFeeNumerator: BN;
  numberOfPeriod: number;
  reductionFactor: BN;
  periodFrequency: BN;
  feeSchedulerMode: number;  // 0 = time, 1 = market cap, 2 = rate limiter
}
```

### SwapMode Enum

```typescript
enum SwapMode {
  ExactIn = 0,      // Specify exact input
  ExactOut = 1,     // Specify exact output
  PartialFill = 2,  // Allow partial fills
}
```

### QuoteResult

```typescript
interface QuoteResult {
  inputAmount: BN;
  outputAmount: BN;
  minimumOutputAmount: BN;
  maximumInputAmount: BN;
  priceImpact: Decimal;
  fee: BN;
  feePercent: Decimal;
}
```

### DepositQuote

```typescript
interface DepositQuote {
  tokenAAmount: BN;
  tokenBAmount: BN;
  liquidityDelta: BN;
  minTokenAAmount: BN;
  minTokenBAmount: BN;
}
```

### WithdrawQuote

```typescript
interface WithdrawQuote {
  tokenAAmount: BN;
  tokenBAmount: BN;
  minTokenAAmount: BN;
  minTokenBAmount: BN;
}
```

## Parameter Interfaces

### CreatePoolParams

```typescript
interface CreatePoolParams {
  creator: PublicKey;
  configAddress: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAAmount: BN;
  tokenBAmount: BN;
}
```

### CreateCustomPoolParams

```typescript
interface CreateCustomPoolParams {
  creator: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAAmount: BN;
  tokenBAmount: BN;
  poolFees: PoolFees;
  hasAlphaVault: boolean;
  activationType: number;      // 0 = slot, 1 = timestamp
  activationPoint: BN | null;  // null = immediate
  collectFeeMode: number;
}
```

### SwapParams

```typescript
interface SwapParams {
  payer: PublicKey;
  pool: PublicKey;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  amountIn: BN;
  minimumAmountOut: BN;
  referralAccount?: PublicKey;
}
```

### AddLiquidityParams

```typescript
interface AddLiquidityParams {
  owner: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  tokenAAmountIn: BN;
  tokenBAmountIn: BN;
  liquidityMin: BN;
}
```

### RemoveLiquidityParams

```typescript
interface RemoveLiquidityParams {
  owner: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  liquidityAmount: BN;
  tokenAAmountMin: BN;
  tokenBAmountMin: BN;
}
```

### LockPositionParams

```typescript
interface LockPositionParams {
  owner: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  vestingDuration: BN;  // Duration in seconds
  cliffDuration: BN;    // Cliff period in seconds
}
```

### GetQuoteParams

```typescript
interface GetQuoteParams {
  poolState: PoolState;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  amount: BN;
  slippageBps: number;
  swapMode: SwapMode;
}
```

## TxBuilder

All methods that create transactions return a `TxBuilder` object:

```typescript
interface TxBuilder {
  // Build transaction
  build(): Promise<Transaction>;

  // Build versioned transaction
  buildVersioned(addressLookupTableAccounts?: AddressLookupTableAccount[]): Promise<VersionedTransaction>;

  // Get instructions
  getInstructions(): TransactionInstruction[];

  // Add signers
  addSigners(signers: Signer[]): TxBuilder;
}
```

## Usage Examples

### Create Pool and Add Liquidity

```typescript
const cpAmm = new CpAmm(connection);

// Create custom pool
const createTx = await cpAmm.createCustomPool({
  creator: wallet.publicKey,
  tokenAMint,
  tokenBMint,
  tokenAAmount: new BN(1_000_000_000),
  tokenBAmount: new BN(1_000_000_000),
  poolFees: {
    baseFee: {
      cliffFeeNumerator: new BN(2500000),
      numberOfPeriod: 0,
      reductionFactor: new BN(0),
      periodFrequency: new BN(0),
      feeSchedulerMode: 0,
    },
    dynamicFee: null,
    protocolFeePercent: 20,
    partnerFeePercent: 0,
    referralFeePercent: 20,
  },
  hasAlphaVault: false,
  activationType: 0,
  activationPoint: null,
  collectFeeMode: 0,
});

const tx = await createTx.build();
const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
```

### Execute Swap

```typescript
const poolState = await cpAmm.fetchPoolState(poolAddress);

// Get quote
const quote = cpAmm.getQuote({
  poolState,
  inputTokenMint: tokenAMint,
  outputTokenMint: tokenBMint,
  amount: new BN(1_000_000),
  slippageBps: 100,
  swapMode: SwapMode.ExactIn,
});

// Execute swap
const swapTx = await cpAmm.swap({
  payer: wallet.publicKey,
  pool: poolAddress,
  inputTokenMint: tokenAMint,
  outputTokenMint: tokenBMint,
  amountIn: new BN(1_000_000),
  minimumAmountOut: quote.minimumOutputAmount,
});

const tx = await swapTx.build();
```

### Manage Position Vesting

```typescript
// Lock position with vesting
const lockTx = await cpAmm.lockPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  vestingDuration: new BN(86400 * 30), // 30 days
  cliffDuration: new BN(86400 * 7),    // 7 day cliff
});

// Later: refresh vesting to unlock available tokens
const refreshTx = await cpAmm.refreshVesting({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
});

// Check vesting status
const vestings = await cpAmm.getAllVestingsByPosition(positionAddress);
for (const vesting of vestings) {
  console.log('Vested:', vesting.vestedAmount.toString());
  console.log('Unlocked:', vesting.unlockedAmount.toString());
}
```
