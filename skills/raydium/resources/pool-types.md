# Raydium Pool Types Comparison

Detailed comparison of Raydium's three AMM types.

## Overview

| Feature | CLMM | CPMM | AMM V4 |
|---------|------|------|--------|
| Full Name | Concentrated Liquidity Market Maker | Constant Product Market Maker | Automated Market Maker |
| Capital Efficiency | High | Medium | Medium |
| Complexity | High | Low | Medium |
| Token22 Support | Limited | Yes | No |
| OpenBook Required | No | No | Yes |
| LP Token | NFT | Fungible | Fungible |
| Price Range | Custom | Full Range | Full Range |

---

## CLMM (Concentrated Liquidity)

### Overview

LPs can concentrate liquidity within specific price ranges for higher capital efficiency.

### Key Features

- **Custom Price Ranges**: Define tick boundaries for liquidity
- **NFT Positions**: Each position is a unique NFT
- **Multiple Positions**: Can have multiple positions per pool
- **Higher APY**: More fees captured in active range
- **Impermanent Loss Risk**: Higher if price moves outside range

### When to Use

- Professional LPs optimizing capital efficiency
- Stablecoin pairs (narrow ranges)
- Active position management
- Higher volume pools

### Code Example

```typescript
// Create CLMM position
const { tick: tickLower } = TickUtils.getPriceAndTick({
  poolInfo,
  price: new Decimal(0.95), // Lower bound
  baseIn: true,
});

const { tick: tickUpper } = TickUtils.getPriceAndTick({
  poolInfo,
  price: new Decimal(1.05), // Upper bound
  baseIn: true,
});

await raydium.clmm.openPositionFromBase({
  poolInfo,
  tickLower,
  tickUpper,
  base: 'MintA',
  baseAmount: new BN(1000000),
  otherAmountMax: new BN(1050000),
});
```

### Position Management

```typescript
// Increase liquidity
await raydium.clmm.increasePositionFromBase({
  poolInfo,
  ownerPosition,
  base: 'MintA',
  baseAmount,
  otherAmountMax,
});

// Decrease liquidity
await raydium.clmm.decreaseLiquidity({
  poolInfo,
  ownerPosition,
  liquidity,
  amountMinA,
  amountMinB,
});

// Close position
await raydium.clmm.closePosition({
  poolInfo,
  ownerPosition,
});
```

---

## CPMM (Constant Product)

### Overview

Simplified AMM using x*y=k formula. No OpenBook market required.

### Key Features

- **Simple Setup**: No external market needed
- **Token22 Support**: Works with new token standard
- **Fungible LP**: Standard SPL token for LP shares
- **Lower Complexity**: Easier to integrate
- **Full Range**: Liquidity across entire price curve

### When to Use

- New token launches
- Token22 tokens
- Simple integrations
- Lower complexity requirements

### Code Example

```typescript
// Create CPMM pool
const { execute } = await raydium.cpmm.createPool({
  mintA: tokenA,
  mintB: tokenB,
  mintAAmount: new BN(1000000000),
  mintBAmount: new BN(1000000000),
  startTime: new BN(0),
  feeConfig: feeConfigs[0], // From API
});

await execute({ sendAndConfirm: true });
```

### Liquidity Operations

```typescript
// Add liquidity
await raydium.cpmm.addLiquidity({
  poolInfo,
  inputAmount: new BN(1000000),
  baseIn: true,
  slippage: 0.01,
});

// Remove liquidity
await raydium.cpmm.withdrawLiquidity({
  poolInfo,
  lpAmount: new BN(500000),
  slippage: 0.01,
});
```

### Lock Liquidity

```typescript
// Lock LP tokens
await raydium.cpmm.lockLiquidity({
  poolInfo,
  lpAmount: new BN(1000000),
});

// Harvest locked rewards
await raydium.cpmm.harvestLockLiquidity({
  poolInfo,
  lockInfo,
});
```

---

## AMM V4 (Legacy)

### Overview

Classic AMM integrated with OpenBook central limit order book.

### Key Features

- **OpenBook Integration**: Shares liquidity with orderbook
- **Fibonacci Orders**: Places limit orders at Fibonacci levels
- **Hybrid Liquidity**: AMM + Orderbook combined
- **Mature Protocol**: Battle-tested, high TVL

### When to Use

- Need orderbook liquidity
- Existing OpenBook market
- Legacy integrations
- High-volume established pairs

### Code Example

```typescript
// Create AMM pool (requires OpenBook market)
const { execute } = await raydium.liquidity.createPoolV4({
  marketInfo: {
    marketId: openBookMarketId,
    programId: OPENBOOK_PROGRAM_ID,
  },
  baseMintInfo: tokenA,
  quoteMintInfo: tokenB,
  baseAmount: new BN(1000000000),
  quoteAmount: new BN(1000000000),
  startTime: new BN(0),
});

await execute({ sendAndConfirm: true });
```

### Liquidity Operations

```typescript
// Add liquidity
await raydium.liquidity.addLiquidity({
  poolInfo,
  amountInA: new BN(1000000),
  amountInB: new BN(1000000),
  fixedSide: 'a',
});

// Remove liquidity
await raydium.liquidity.removeLiquidity({
  poolInfo,
  lpAmount: new BN(500000),
});
```

---

## Choosing the Right Pool Type

### Decision Matrix

| Scenario | Recommended |
|----------|-------------|
| New token launch | CPMM |
| Token22 token | CPMM |
| Stablecoin pair | CLMM (narrow range) |
| Active LP management | CLMM |
| Passive LP | CPMM or AMM |
| Need orderbook | AMM V4 |
| Maximum capital efficiency | CLMM |
| Simple integration | CPMM |

### Fee Comparison

| Pool Type | Typical Fees | LP Share |
|-----------|--------------|----------|
| CLMM | 0.01% - 1% | Based on range |
| CPMM | 0.25% | Pro-rata |
| AMM V4 | 0.25% | Pro-rata |

### Capital Requirements

| Pool Type | Minimum | Notes |
|-----------|---------|-------|
| CLMM | Variable | Depends on range width |
| CPMM | ~0.5 SOL | Pool creation fee |
| AMM V4 | ~3 SOL | Includes OpenBook market |

---

## Swap Routing

For best execution, Raydium's router aggregates across all pool types:

```typescript
// Route swap finds best path
const routes = await raydium.tradeV2.computeRoutes({
  inputMint,
  outputMint,
  amount,
  slippage,
});

// Execute best route
await raydium.tradeV2.swap({
  routeInfo: routes[0],
});
```
