# CLMM Position Management

Create, manage, and close concentrated liquidity positions.

## Open Position

```typescript
import { Raydium, TickUtils, PoolUtils } from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair } from '@solana/web3.js';
import Decimal from 'decimal.js';
import BN from 'bn.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const owner = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

async function openPosition() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // RAY-USDC pool
  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';

  // Fetch pool info
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  // Current price
  const currentPrice = poolInfo.price;
  console.log('Current price:', currentPrice);

  // Define price range (±20% from current)
  const lowerPrice = currentPrice * 0.8;
  const upperPrice = currentPrice * 1.2;

  // Get tick boundaries
  const { tick: tickLower } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(lowerPrice),
    baseIn: true,
  });

  const { tick: tickUpper } = TickUtils.getPriceAndTick({
    poolInfo,
    price: new Decimal(upperPrice),
    baseIn: true,
  });

  console.log('Price range:', lowerPrice, '-', upperPrice);
  console.log('Tick range:', tickLower, '-', tickUpper);

  // Amount to deposit (base token)
  const baseAmount = new BN(1000000); // 1 RAY (6 decimals)

  // Calculate other token amount
  const { amountB } = PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    tickLower,
    tickUpper,
    amount: baseAmount,
    slippage: 0.01,
    add: true,
    amountHasFee: true,
    token: poolInfo.mintA,
  });

  // Open position
  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo,
    tickLower,
    tickUpper,
    base: 'MintA',
    baseAmount,
    otherAmountMax: amountB.mul(new BN(102)).div(new BN(100)), // +2% buffer
    txVersion: 'V0',
    computeBudgetConfig: {
      units: 600000,
      microLamports: 100000,
    },
  });

  const { txId } = await execute({ sendAndConfirm: true });

  console.log('Position NFT:', extInfo.nftMint.toBase58());
  console.log('TX:', `https://solscan.io/tx/${txId}`);

  return extInfo.nftMint;
}
```

## Fetch User Positions

```typescript
async function getPositions() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  // Get all positions for owner in this pool
  const positions = await raydium.clmm.getOwnerPositionInfo({
    poolId,
  });

  positions.forEach((pos, i) => {
    console.log(`\nPosition ${i + 1}:`);
    console.log('  NFT:', pos.nftMint.toBase58());
    console.log('  Liquidity:', pos.liquidity.toString());
    console.log('  Tick range:', pos.tickLower, '-', pos.tickUpper);
    console.log('  Fees owed A:', pos.tokenFeeAmountA.toString());
    console.log('  Fees owed B:', pos.tokenFeeAmountB.toString());
  });

  return positions;
}
```

## Increase Liquidity

```typescript
async function increaseLiquidity(positionNftMint: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  // Get position info
  const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });
  const position = positions.find(
    (p) => p.nftMint.toBase58() === positionNftMint
  );

  if (!position) {
    throw new Error('Position not found');
  }

  // Amount to add
  const additionalAmount = new BN(500000); // 0.5 RAY

  // Calculate required other token
  const { amountB } = PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    amount: additionalAmount,
    slippage: 0.01,
    add: true,
    amountHasFee: true,
    token: poolInfo.mintA,
  });

  const { execute } = await raydium.clmm.increasePositionFromBase({
    poolInfo,
    ownerPosition: position,
    base: 'MintA',
    baseAmount: additionalAmount,
    otherAmountMax: amountB.mul(new BN(102)).div(new BN(100)),
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Increased liquidity:', `https://solscan.io/tx/${txId}`);
}
```

## Decrease Liquidity

```typescript
async function decreaseLiquidity(positionNftMint: string, percentage: number) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });
  const position = positions.find(
    (p) => p.nftMint.toBase58() === positionNftMint
  );

  if (!position) {
    throw new Error('Position not found');
  }

  // Calculate liquidity to remove
  const liquidityToRemove = position.liquidity
    .mul(new BN(percentage))
    .div(new BN(100));

  // Calculate minimum amounts out
  const { amountA, amountB } = PoolUtils.getAmountsFromLiquidity({
    poolInfo,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: liquidityToRemove,
    slippage: 0.01,
    add: false,
  });

  const { execute } = await raydium.clmm.decreaseLiquidity({
    poolInfo,
    ownerPosition: position,
    liquidity: liquidityToRemove,
    amountMinA: amountA.mul(new BN(98)).div(new BN(100)), // -2% slippage
    amountMinB: amountB.mul(new BN(98)).div(new BN(100)),
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Decreased liquidity:', `https://solscan.io/tx/${txId}`);
}
```

## Harvest Fees

```typescript
async function harvestFees(positionNftMint: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });
  const position = positions.find(
    (p) => p.nftMint.toBase58() === positionNftMint
  );

  if (!position) {
    throw new Error('Position not found');
  }

  console.log('Pending fees:');
  console.log('  Token A:', position.tokenFeeAmountA.toString());
  console.log('  Token B:', position.tokenFeeAmountB.toString());

  // Harvest by decreasing 0 liquidity
  const { execute } = await raydium.clmm.decreaseLiquidity({
    poolInfo,
    ownerPosition: position,
    liquidity: new BN(0),
    amountMinA: new BN(0),
    amountMinB: new BN(0),
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Fees harvested:', `https://solscan.io/tx/${txId}`);
}
```

## Close Position

```typescript
async function closePosition(positionNftMint: string) {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  const poolId = 'DiwsGxJYoRZURvyCtMsJVyxR86yZBBbSYeeWNm7YCmT6';
  const poolData = await raydium.api.fetchPoolById({ ids: poolId });
  const poolInfo = poolData[0];

  const positions = await raydium.clmm.getOwnerPositionInfo({ poolId });
  const position = positions.find(
    (p) => p.nftMint.toBase58() === positionNftMint
  );

  if (!position) {
    throw new Error('Position not found');
  }

  // First remove all liquidity if any remains
  if (!position.liquidity.isZero()) {
    const { amountA, amountB } = PoolUtils.getAmountsFromLiquidity({
      poolInfo,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity,
      slippage: 0.01,
      add: false,
    });

    const { execute: removeLiq } = await raydium.clmm.decreaseLiquidity({
      poolInfo,
      ownerPosition: position,
      liquidity: position.liquidity,
      amountMinA: amountA.mul(new BN(95)).div(new BN(100)),
      amountMinB: amountB.mul(new BN(95)).div(new BN(100)),
      txVersion: 'V0',
    });

    await removeLiq({ sendAndConfirm: true });
  }

  // Close position (burns NFT)
  const { execute } = await raydium.clmm.closePosition({
    poolInfo,
    ownerPosition: position,
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('Position closed:', `https://solscan.io/tx/${txId}`);
}
```

## Harvest All Rewards (Multiple Positions)

```typescript
async function harvestAllRewards() {
  const raydium = await Raydium.load({
    connection,
    owner,
    cluster: 'mainnet',
  });

  // Get all pools with positions
  const allPoolInfo = []; // Fetch from API or known pools
  const allPositions = [];

  // Gather positions from each pool
  for (const poolInfo of allPoolInfo) {
    const positions = await raydium.clmm.getOwnerPositionInfo({
      poolId: poolInfo.id,
    });
    allPositions.push(...positions.map((p) => ({ poolInfo, position: p })));
  }

  if (allPositions.length === 0) {
    console.log('No positions found');
    return;
  }

  // Harvest all
  const { execute } = await raydium.clmm.harvestAllRewards({
    allPoolInfo,
    allPositions: allPositions.map((p) => p.position),
    txVersion: 'V0',
  });

  const { txId } = await execute({ sendAndConfirm: true });
  console.log('All rewards harvested:', `https://solscan.io/tx/${txId}`);
}
```

## Price Range Strategies

| Strategy | Range | Risk | Rewards |
|----------|-------|------|---------|
| Wide | ±50% | Low IL | Lower APY |
| Medium | ±20% | Medium IL | Medium APY |
| Narrow | ±5% | High IL | Highest APY |
| Stablecoin | ±1% | Very Low | Optimal |
