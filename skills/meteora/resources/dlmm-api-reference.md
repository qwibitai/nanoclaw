# DLMM SDK API Reference

Complete API reference for the `@meteora-ag/dlmm` package.

## Installation

```bash
npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js
```

## DLMM Class

### Static Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `create(connection, poolAddress, opt?)` | Create DLMM instance for pool | `Connection`, `PublicKey`, `Opt?` | `Promise<DLMM>` |
| `createMultiple(connection, poolAddresses, opt?)` | Create multiple DLMM instances | `Connection`, `PublicKey[]`, `Opt?` | `Promise<DLMM[]>` |
| `getAllPresetParameters()` | Get all preset pool configurations | - | `PresetParameter[]` |
| `createPermissionLbPair(params)` | Deploy a new DLMM pool | `CreatePermissionLbPairParams` | `Promise<Transaction>` |
| `getClaimableLMReward(connection, position)` | Query claimable LM rewards | `Connection`, `PublicKey` | `Promise<ClaimableReward>` |
| `getClaimableSwapFee(connection, position)` | Query claimable swap fees | `Connection`, `PublicKey` | `Promise<ClaimableFee>` |
| `getAllLbPairPositionsByUser(connection, user)` | Get all user positions across pools | `Connection`, `PublicKey` | `Promise<Map<string, Position[]>>` |

### Instance Methods - State Management

| Method | Description | Returns |
|--------|-------------|---------|
| `refetchStates()` | Refresh pool state from blockchain | `Promise<void>` |
| `getBinArrays()` | Fetch all bin arrays | `Promise<BinArray[]>` |
| `getBinArrayForSwap(swapForY)` | Get bin arrays optimized for swap | `Promise<BinArray[]>` |

### Instance Methods - Price & Bin Operations

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getActiveBin()` | Get current active trading bin | - | `Promise<ActiveBin>` |
| `getPriceOfBinByBinId(binId)` | Convert bin ID to price | `number` | `string` |
| `getBinIdFromPrice(price, roundDown?)` | Convert price to bin ID | `string`, `boolean?` | `number` |
| `toPricePerLamport(price)` | Transform real price to lamport | `number` | `string` |
| `fromPricePerLamport(price)` | Transform lamport price to real | `string` | `number` |
| `getBinsBetweenLowerAndUpperBound(min, max)` | Fetch bins within range | `number`, `number` | `Promise<Bin[]>` |
| `getBinsAroundActiveBin(count)` | Get surrounding bins | `number` | `Promise<Bin[]>` |

### Instance Methods - Liquidity Management

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `initializePositionAndAddLiquidityByStrategy(params)` | Create new position with strategy | `AddLiquidityByStrategyParams` | `Promise<Transaction>` |
| `addLiquidityByStrategy(params)` | Add liquidity to existing position | `AddLiquidityByStrategyParams` | `Promise<Transaction>` |
| `removeLiquidity(params)` | Withdraw liquidity | `RemoveLiquidityParams` | `Promise<Transaction>` |
| `closePosition(params)` | Terminate position | `ClosePositionParams` | `Promise<Transaction>` |

### Instance Methods - Trading

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `swapQuote(amount, direction, slippage, binArrays)` | Calculate swap output | `BN`, `boolean`, `number`, `BinArray[]` | `SwapQuote` |
| `swap(params)` | Execute token swap | `SwapParams` | `Promise<Transaction>` |

### Instance Methods - Rewards

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `claimSwapFee(params)` | Claim accumulated fees | `ClaimFeeParams` | `Promise<Transaction>` |
| `claimAllSwapFee(params)` | Claim fees from multiple positions | `ClaimAllFeeParams` | `Promise<Transaction>` |
| `claimLMReward(params)` | Claim LM rewards | `ClaimRewardParams` | `Promise<Transaction>` |
| `claimAllLMRewards(params)` | Claim all LM rewards | `ClaimAllRewardsParams` | `Promise<Transaction>` |
| `claimAllRewards(params)` | Claim all fees and rewards | `ClaimAllRewardsParams` | `Promise<Transaction>` |

### Instance Methods - Utilities

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `getFeeInfo()` | Query fee structure | - | `FeeInfo` |
| `getDynamicFee()` | Get current dynamic fee | - | `number` |
| `syncWithMarketPrice(params)` | Realign to market price | `SyncParams` | `Promise<Transaction>` |
| `getPairPubkeyIfExists(tokenX, tokenY, binStep)` | Find pool address | `PublicKey`, `PublicKey`, `number` | `PublicKey \| null` |
| `getMaxPriceInBinArrays()` | Get highest available price | - | `string` |

## Types

### ActiveBin

```typescript
interface ActiveBin {
  binId: number;
  price: string;
  xAmount: BN;
  yAmount: BN;
  supply: BN;
}
```

### SwapQuote

```typescript
interface SwapQuote {
  consumedInAmount: BN;
  outAmount: BN;
  minOutAmount: BN;
  fee: BN;
  priceImpact: Decimal;
  protocolFee: BN;
  binArraysPubkey: PublicKey[];
}
```

### Position

```typescript
interface Position {
  publicKey: PublicKey;
  positionData: {
    positionBinData: PositionBinData[];
    lastUpdatedAt: BN;
    totalXAmount: BN;
    totalYAmount: BN;
    feeX: BN;
    feeY: BN;
    rewardOne: BN;
    rewardTwo: BN;
  };
}
```

### StrategyType Enum

```typescript
enum StrategyType {
  SpotOneSide = 0,      // Single-sided at current price
  CurveOneSide = 1,     // Curve distribution one side
  BidAskOneSide = 2,    // Bid/ask one side
  SpotBalanced = 3,     // Balanced around current
  CurveBalanced = 4,    // Curve balanced
  BidAskBalanced = 5,   // Bid/ask balanced
  SpotImBalanced = 6,   // Imbalanced spot
  CurveImBalanced = 7,  // Imbalanced curve
  BidAskImBalanced = 8, // Imbalanced bid/ask
}
```

### FeeInfo

```typescript
interface FeeInfo {
  baseFeeRate: number;      // Base fee percentage
  maxFeeRate: number;       // Maximum fee percentage
  protocolFeeRate: number;  // Protocol's cut
}
```

## Parameter Interfaces

### AddLiquidityByStrategyParams

```typescript
interface AddLiquidityByStrategyParams {
  positionPubKey: PublicKey;
  user: PublicKey;
  totalXAmount: BN;
  totalYAmount: BN;
  strategy: {
    maxBinId: number;
    minBinId: number;
    strategyType: StrategyType;
  };
  slippage?: number;
}
```

### RemoveLiquidityParams

```typescript
interface RemoveLiquidityParams {
  position: PublicKey;
  user: PublicKey;
  binIds: number[];
  bps: BN;           // Percentage in basis points (10000 = 100%)
  shouldClaimAndClose: boolean;
}
```

### SwapParams

```typescript
interface SwapParams {
  inToken: PublicKey;
  outToken: PublicKey;
  inAmount: BN;
  minOutAmount: BN;
  lbPair: PublicKey;
  user: PublicKey;
  binArraysPubkey: PublicKey[];
}
```

### ClaimFeeParams

```typescript
interface ClaimFeeParams {
  owner: PublicKey;
  position: PublicKey;
}
```

## Usage Examples

### Complete Swap Flow

```typescript
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';

async function executeSwap() {
  const connection = new Connection('https://api.mainnet-beta.solana.com');
  const dlmm = await DLMM.create(connection, poolAddress);

  // Refresh state
  await dlmm.refetchStates();

  // Get swap quote
  const amount = new BN(1_000_000);
  const swapForY = true;
  const slippageBps = 100;

  const binArrays = await dlmm.getBinArrayForSwap(swapForY);
  const quote = dlmm.swapQuote(amount, swapForY, slippageBps, binArrays);

  // Execute swap
  const tx = await dlmm.swap({
    inToken: tokenXMint,
    outToken: tokenYMint,
    inAmount: amount,
    minOutAmount: quote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });

  return tx;
}
```

### Complete Liquidity Flow

```typescript
async function manageLiquidity() {
  const dlmm = await DLMM.create(connection, poolAddress);
  const activeBin = await dlmm.getActiveBin();

  // Create new position
  const positionKeypair = Keypair.generate();
  const addLiqTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(100_000_000),
    totalYAmount: new BN(100_000_000),
    strategy: {
      maxBinId: activeBin.binId + 10,
      minBinId: activeBin.binId - 10,
      strategyType: StrategyType.SpotBalanced,
    },
  });

  // Later: remove liquidity
  const removeTx = await dlmm.removeLiquidity({
    position: positionKeypair.publicKey,
    user: wallet.publicKey,
    binIds: [-10, -9, -8, ..., 8, 9, 10].map(i => activeBin.binId + i),
    bps: new BN(5000), // 50%
    shouldClaimAndClose: false,
  });

  // Claim fees
  const claimTx = await dlmm.claimSwapFee({
    owner: wallet.publicKey,
    position: positionKeypair.publicKey,
  });
}
```
