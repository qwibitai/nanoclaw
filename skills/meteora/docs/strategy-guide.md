# Meteora Liquidity Strategy Guide

Advanced guide to liquidity provision strategies on Meteora protocols.

## DLMM Strategy Types

### Overview

DLMM offers nine strategy types for liquidity distribution:

| Strategy | Distribution | Best For |
|----------|-------------|----------|
| SpotOneSide | Single-sided at active | Range orders |
| CurveOneSide | Curve on one side | Directional bets |
| BidAskOneSide | Bid/ask one side | Order book simulation |
| SpotBalanced | Even around active | Standard LP |
| CurveBalanced | Bell curve around active | Concentrated LP |
| BidAskBalanced | Bid/ask both sides | Market making |
| SpotImBalanced | Weighted distribution | Custom ranges |
| CurveImBalanced | Asymmetric curve | Directional LP |
| BidAskImBalanced | Asymmetric bid/ask | Custom MM |

### Strategy Selection Flowchart

```
                          ┌─────────────────┐
                          │ What's your goal│
                          └────────┬────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        ┌─────────┐          ┌─────────┐          ┌─────────┐
        │ Passive │          │ Active  │          │ Range   │
        │ Earning │          │ Trading │          │ Orders  │
        └────┬────┘          └────┬────┘          └────┬────┘
             │                    │                    │
             ▼                    ▼                    ▼
    ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
    │ SpotBalanced   │   │ BidAskBalanced │   │ SpotOneSide    │
    │ CurveBalanced  │   │ Custom ranges  │   │ CurveOneSide   │
    └────────────────┘   └────────────────┘   └────────────────┘
```

### SpotBalanced Strategy

**Use Case**: Standard liquidity provision with equal distribution.

```typescript
const strategy = {
  maxBinId: activeBin.binId + 10,
  minBinId: activeBin.binId - 10,
  strategyType: StrategyType.SpotBalanced,
};
```

**Characteristics**:
- Equal liquidity in each bin
- Symmetric around active bin
- Good for stable pairs
- Simple to understand

### CurveBalanced Strategy

**Use Case**: Concentrated liquidity around current price.

```typescript
const strategy = {
  maxBinId: activeBin.binId + 15,
  minBinId: activeBin.binId - 15,
  strategyType: StrategyType.CurveBalanced,
};
```

**Characteristics**:
- Bell curve distribution
- More liquidity near active bin
- Higher capital efficiency
- Better for low-volatility pairs

### BidAskBalanced Strategy

**Use Case**: Market making with spread capture.

```typescript
const strategy = {
  maxBinId: activeBin.binId + 5,
  minBinId: activeBin.binId - 5,
  strategyType: StrategyType.BidAskBalanced,
};
```

**Characteristics**:
- Tight spreads around active
- Mimics order book
- Good for active rebalancing
- Higher fee capture potential

### One-Sided Strategies

**Use Case**: Directional positions or range orders.

```typescript
// Only provide liquidity above current price (expecting price rise)
const strategy = {
  maxBinId: activeBin.binId + 20,
  minBinId: activeBin.binId + 1, // Above active bin only
  strategyType: StrategyType.SpotOneSide,
};
```

---

## Bin Range Selection

### Volatility-Based Selection

| Asset Type | Typical Volatility | Recommended Bin Range |
|------------|-------------------|----------------------|
| Stablecoins | < 0.5% | 5-10 bins |
| Major (BTC, ETH) | 2-5% | 10-20 bins |
| Mid-cap | 5-10% | 20-40 bins |
| Small-cap | > 10% | 40-100 bins |

### Calculating Optimal Range

```typescript
// Based on expected price movement
function calculateBinRange(expectedVolatility: number, binStep: number): number {
  // Convert volatility to price range
  const priceRange = expectedVolatility * 2; // 2 standard deviations

  // Each bin represents binStep basis points
  const binsNeeded = Math.ceil((priceRange * 10000) / binStep);

  return binsNeeded;
}

// Example: 5% expected volatility, 10 bps bin step
const range = calculateBinRange(0.05, 10); // = 100 bins total (50 each side)
```

### Dynamic Range Adjustment

```typescript
async function shouldAdjustRange(dlmm: DLMM, position: Position): Promise<boolean> {
  const activeBin = await dlmm.getActiveBin();
  const positionBins = position.positionData.positionBinData;

  const minBin = Math.min(...positionBins.map(b => b.binId));
  const maxBin = Math.max(...positionBins.map(b => b.binId));

  // Check if active bin is near edges
  const margin = 3; // bins
  if (activeBin.binId <= minBin + margin || activeBin.binId >= maxBin - margin) {
    return true; // Need to rebalance
  }

  return false;
}
```

---

## DAMM v2 Strategies

### Full Range Liquidity

Provide liquidity across entire price range:

```typescript
// Add liquidity proportional to pool reserves
const depositQuote = cpAmm.getDepositQuote({
  poolState,
  tokenAAmount: new BN(100_000_000),
  tokenBAmount: new BN(100_000_000),
  slippageBps: 100,
});

// Both tokens used at current ratio
console.log('Token A:', depositQuote.tokenAAmount.toString());
console.log('Token B:', depositQuote.tokenBAmount.toString());
```

### Position Vesting

Lock liquidity for long-term commitment:

```typescript
// Lock with 30-day vesting, 7-day cliff
await cpAmm.lockPosition({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  vestingDuration: new BN(86400 * 30),
  cliffDuration: new BN(86400 * 7),
});
```

**Benefits**:
- Shows commitment to project
- May receive additional incentives
- Prevents impulsive withdrawals

---

## Risk Management

### Impermanent Loss Considerations

| Strategy | IL Risk | Fee Potential | Best Market |
|----------|---------|---------------|-------------|
| Wide range | Low | Low | Volatile |
| Narrow range | High | High | Stable |
| One-sided | Variable | Variable | Directional |

### Calculating IL

```typescript
function calculateIL(priceChange: number): number {
  // IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
  const priceRatio = 1 + priceChange;
  const sqrtRatio = Math.sqrt(priceRatio);
  const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;

  return il * 100; // Percentage
}

// 50% price increase
console.log('IL at +50%:', calculateIL(0.5).toFixed(2), '%'); // -2.02%

// 50% price decrease
console.log('IL at -50%:', calculateIL(-0.5).toFixed(2), '%'); // -5.72%
```

### Fee vs IL Break-even

```typescript
function feesNeededToBreakEven(
  positionValue: number,
  ilPercent: number
): number {
  return positionValue * Math.abs(ilPercent);
}

// $10,000 position, 3% IL
const feesNeeded = feesNeededToBreakEven(10000, 0.03);
console.log('Fees needed:', feesNeeded); // $300
```

---

## Automated Strategies

### Rebalancing Logic

```typescript
async function autoRebalance(
  dlmm: DLMM,
  position: PublicKey,
  config: {
    rebalanceThreshold: number; // bins
    targetRange: number;
    strategy: StrategyType;
  }
) {
  const activeBin = await dlmm.getActiveBin();
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  const pos = positions.find(p => p.publicKey.equals(position));

  if (!pos) return;

  const bins = pos.positionData.positionBinData;
  const centerBin = Math.floor((Math.max(...bins.map(b => b.binId)) + Math.min(...bins.map(b => b.binId))) / 2);

  const drift = Math.abs(activeBin.binId - centerBin);

  if (drift >= config.rebalanceThreshold) {
    console.log(`Rebalancing: drift ${drift} bins`);

    // Remove liquidity
    const removeTx = await dlmm.removeLiquidity({
      position,
      user: wallet.publicKey,
      binIds: bins.map(b => b.binId),
      bps: new BN(10000),
      shouldClaimAndClose: false,
    });
    await sendAndConfirmTransaction(connection, removeTx, [wallet]);

    // Add at new range
    const addTx = await dlmm.addLiquidityByStrategy({
      positionPubKey: position,
      user: wallet.publicKey,
      totalXAmount: pos.positionData.totalXAmount,
      totalYAmount: pos.positionData.totalYAmount,
      strategy: {
        maxBinId: activeBin.binId + config.targetRange,
        minBinId: activeBin.binId - config.targetRange,
        strategyType: config.strategy,
      },
    });
    await sendAndConfirmTransaction(connection, addTx, [wallet]);
  }
}
```

### Fee Compounding

```typescript
async function compoundFees(dlmm: DLMM, position: PublicKey) {
  // Claim fees
  const claimTx = await dlmm.claimSwapFee({
    owner: wallet.publicKey,
    position,
  });
  await sendAndConfirmTransaction(connection, claimTx, [wallet]);

  // Get claimed amounts
  const tokenXBalance = await getTokenBalance(tokenXMint, wallet.publicKey);
  const tokenYBalance = await getTokenBalance(tokenYMint, wallet.publicKey);

  if (tokenXBalance.gt(new BN(0)) && tokenYBalance.gt(new BN(0))) {
    // Add back as liquidity
    const activeBin = await dlmm.getActiveBin();

    const addTx = await dlmm.addLiquidityByStrategy({
      positionPubKey: position,
      user: wallet.publicKey,
      totalXAmount: tokenXBalance,
      totalYAmount: tokenYBalance,
      strategy: {
        maxBinId: activeBin.binId + 5,
        minBinId: activeBin.binId - 5,
        strategyType: StrategyType.SpotBalanced,
      },
    });
    await sendAndConfirmTransaction(connection, addTx, [wallet]);
  }
}
```

---

## Strategy Comparison Matrix

| Metric | SpotBalanced | CurveBalanced | BidAskBalanced | OneSided |
|--------|--------------|---------------|----------------|----------|
| Capital Efficiency | Medium | High | Very High | Variable |
| IL Risk | Medium | Higher | Highest | Lower |
| Fee Capture | Medium | High | Very High | Lower |
| Rebalancing Need | Medium | High | Very High | Low |
| Complexity | Low | Medium | High | Low |
| Best For | Passive LP | Active LP | Market Makers | Range Orders |
