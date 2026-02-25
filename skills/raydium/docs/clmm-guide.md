# CLMM Deep Dive Guide

Comprehensive guide to Concentrated Liquidity Market Making on Raydium.

## What is CLMM?

Concentrated Liquidity Market Maker allows liquidity providers to allocate capital within specific price ranges, rather than across the entire price curve.

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Tick** | Discrete price point on the curve |
| **Range** | Lower and upper tick boundaries |
| **Position** | Your liquidity within a specific range |
| **NFT** | Each position is represented as an NFT |
| **Active Liquidity** | Liquidity in range earns fees |

## How Ticks Work

```
Price Scale (log):
├─ Tick -100000 = $0.0001
├─ Tick -50000  = $0.01
├─ Tick 0       = $1.00
├─ Tick 50000   = $100
└─ Tick 100000  = $10000

Tick Spacing (depends on fee tier):
- 0.01% fee → 1 tick spacing
- 0.05% fee → 10 tick spacing
- 0.25% fee → 60 tick spacing
- 1% fee    → 200 tick spacing
```

## Price Range Strategies

### Wide Range (Conservative)

```typescript
// ±50% from current price
const currentPrice = poolInfo.price;
const lowerPrice = currentPrice * 0.5;
const upperPrice = currentPrice * 1.5;
```

**Pros:**
- Less rebalancing needed
- Lower impermanent loss risk
- Liquidity always in range

**Cons:**
- Lower capital efficiency
- Lower fee APY

### Narrow Range (Aggressive)

```typescript
// ±5% from current price
const currentPrice = poolInfo.price;
const lowerPrice = currentPrice * 0.95;
const upperPrice = currentPrice * 1.05;
```

**Pros:**
- High capital efficiency
- Higher fee APY when in range

**Cons:**
- Frequent rebalancing needed
- Higher impermanent loss risk
- May go out of range

### Stablecoin Strategy

```typescript
// ±1% for stable pairs (USDC-USDT)
const lowerPrice = 0.99;
const upperPrice = 1.01;
```

**Optimal for:**
- USDC/USDT
- USDC/PYUSD
- Other pegged pairs

## Calculating Ticks

```typescript
import { TickUtils, PoolUtils } from '@raydium-io/raydium-sdk-v2';
import Decimal from 'decimal.js';

// Price to tick
const { tick, price: adjustedPrice } = TickUtils.getPriceAndTick({
  poolInfo,
  price: new Decimal(1.5),
  baseIn: true,
});

// Tick to price
const priceFromTick = TickUtils.getTickPrice({
  poolInfo,
  tick: 1000,
  baseIn: true,
});

// Get nearest valid tick
const validTick = TickUtils.getNearestValidTick({
  tick: 1234,
  tickSpacing: poolInfo.config.tickSpacing,
});
```

## Liquidity Math

### Amount Calculations

```typescript
import { PoolUtils } from '@raydium-io/raydium-sdk-v2';

// Calculate amounts from liquidity
const { amountA, amountB } = PoolUtils.getAmountsFromLiquidity({
  poolInfo,
  tickLower,
  tickUpper,
  liquidity: new BN(1000000),
  slippage: 0.01,
  add: true, // true for deposit, false for withdraw
});

// Calculate liquidity from amount
const { liquidity, anotherAmount } = PoolUtils.getLiquidityAmountOutFromAmountIn({
  poolInfo,
  tickLower,
  tickUpper,
  amount: new BN(1000000),
  slippage: 0.01,
  add: true,
  amountHasFee: false,
  token: poolInfo.mintA, // Which token amount is provided
});
```

### Fee Calculations

```typescript
// Fees are accumulated in the position
const position = await raydium.clmm.getOwnerPositionInfo({ poolId });

const pendingFeesA = position[0].tokenFeeAmountA;
const pendingFeesB = position[0].tokenFeeAmountB;

// Estimate APY from fees
const dailyFees = /* historical data */;
const liquidityValue = /* position value in USD */;
const estimatedAPY = (dailyFees * 365 / liquidityValue) * 100;
```

## Position Management Strategies

### Single Position

Simple: One position covering your target range.

```typescript
await raydium.clmm.openPositionFromBase({
  poolInfo,
  tickLower: -5000,
  tickUpper: 5000,
  base: 'MintA',
  baseAmount: new BN(1000000),
  otherAmountMax: calculatedMax,
});
```

### Multiple Positions (Ladder)

Spread liquidity across multiple ranges for different scenarios.

```typescript
const ranges = [
  { lower: 0.8, upper: 0.95 },   // Below current
  { lower: 0.95, upper: 1.05 },  // Around current
  { lower: 1.05, upper: 1.2 },   // Above current
];

for (const range of ranges) {
  const { tick: tickLower } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(currentPrice * range.lower),
    baseIn: true,
  });

  const { tick: tickUpper } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(currentPrice * range.upper),
    baseIn: true,
  });

  await raydium.clmm.openPositionFromBase({
    poolInfo,
    tickLower,
    tickUpper,
    base: 'MintA',
    baseAmount: amountPerRange,
    otherAmountMax: calculatedMax,
  });
}
```

### Dynamic Rebalancing

Monitor and adjust positions as price moves.

```typescript
async function checkAndRebalance(poolId: string, positionNft: string) {
  const raydium = await Raydium.load({...});

  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });
  const position = positions.find(p => p.nftMint.toBase58() === positionNft);

  if (!position) return;

  const currentTick = poolInfo.tickCurrent;
  const isInRange = currentTick >= position.tickLower &&
                    currentTick <= position.tickUpper;

  if (!isInRange) {
    console.log('Position out of range! Rebalancing...');

    // Close old position
    await closePosition(positionNft);

    // Open new position around current price
    await openPositionAroundCurrent(poolId, currentPrice);
  }
}
```

## Impermanent Loss

### Understanding IL in CLMM

IL is amplified in concentrated positions:
- Narrower range = Higher IL when price moves
- Wider range = Lower IL but less capital efficiency

### IL Calculation

```typescript
function calculateIL(
  initialPriceRatio: number,
  currentPriceRatio: number,
  rangeWidth: number
): number {
  // Simplified IL formula for concentrated liquidity
  const priceChange = currentPriceRatio / initialPriceRatio;
  const sqrtPrice = Math.sqrt(priceChange);

  // IL increases with concentration
  const concentrationFactor = 1 / rangeWidth;

  const holdValue = (1 + priceChange) / 2;
  const lpValue = sqrtPrice;

  const il = (holdValue - lpValue) / holdValue;
  return il * concentrationFactor;
}
```

## Fee Tiers

| Fee Tier | Best For | Tick Spacing |
|----------|----------|--------------|
| 0.01% | Stablecoins | 1 |
| 0.05% | Correlated pairs | 10 |
| 0.25% | Most pairs | 60 |
| 1% | Exotic/volatile | 200 |

### Choosing Fee Tier

```typescript
const feeConfigs = await raydium.api.getClmmConfigs();

// For stablecoins
const stableFee = feeConfigs.find(c => c.tradeFeeRate === 100);

// For standard pairs
const standardFee = feeConfigs.find(c => c.tradeFeeRate === 2500);

// For volatile pairs
const volatileFee = feeConfigs.find(c => c.tradeFeeRate === 10000);
```

## Monitoring Positions

```typescript
async function monitorPosition(poolId: string) {
  const raydium = await Raydium.load({...});

  // Subscribe to pool updates
  const poolSub = raydium.connection.onAccountChange(
    new PublicKey(poolId),
    async (accountInfo) => {
      // Decode and check if rebalance needed
      const poolData = await raydium.api.fetchPoolById({ ids: poolId });
      console.log('Current tick:', poolData[0].tickCurrent);
      console.log('Current price:', poolData[0].price);
    }
  );

  return () => raydium.connection.removeAccountChangeListener(poolSub);
}
```

## Best Practices

1. **Start Wide**: Begin with wider ranges, narrow as you gain experience
2. **Monitor Regularly**: Check positions at least daily for volatile pairs
3. **Consider Gas**: Factor in rebalancing costs when choosing range width
4. **Diversify**: Don't put all liquidity in one range
5. **Harvest Fees**: Collect fees regularly to compound returns
6. **Use Multiple Positions**: Ladder strategy reduces risk
