# Market Making Guide

## Overview

Market making on Drift involves providing liquidity by placing bid and ask orders. Makers earn rebates when their orders are filled by takers.

## Key Concepts

### Maker vs Taker

| Role | Description | Fees |
|------|-------------|------|
| **Maker** | Provides liquidity (orders rest in book) | Receives rebate |
| **Taker** | Removes liquidity (crosses spread) | Pays fee |

### Post-Only Orders

Use post-only parameters to ensure maker status:

```typescript
import { PostOnlyParams } from '@drift-labs/sdk';

// MUST_POST_ONLY - Fail if would be taker
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(99),
  postOnly: PostOnlyParams.MUST_POST_ONLY,
});

// TRY_POST_ONLY - Skip if would be taker (no fail)
postOnly: PostOnlyParams.TRY_POST_ONLY,

// SLIDE - Adjust price to ensure maker
postOnly: PostOnlyParams.SLIDE,
```

## Basic Market Making Strategy

### Two-Sided Quotes

```typescript
async function placeQuotes(
  marketIndex: number,
  bidPrice: number,
  askPrice: number,
  size: number
) {
  await driftClient.placeOrders([
    // Bid
    {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: PositionDirection.LONG,
      baseAssetAmount: driftClient.convertToPerpPrecision(size),
      price: driftClient.convertToPricePrecision(bidPrice),
      postOnly: PostOnlyParams.MUST_POST_ONLY,
    },
    // Ask
    {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount: driftClient.convertToPerpPrecision(size),
      price: driftClient.convertToPricePrecision(askPrice),
      postOnly: PostOnlyParams.MUST_POST_ONLY,
    },
  ]);
}
```

### Quote Around Oracle

```typescript
async function quoteAroundOracle(
  marketIndex: number,
  spreadBps: number,
  size: number
) {
  // Get oracle price
  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

  // Calculate spread
  const halfSpread = oraclePrice * (spreadBps / 10000) / 2;
  const bidPrice = oraclePrice - halfSpread;
  const askPrice = oraclePrice + halfSpread;

  await placeQuotes(marketIndex, bidPrice, askPrice, size);
}
```

## Advanced Strategies

### JIT (Just-In-Time) Maker

Fill taker orders atomically as maker:

```typescript
// JIT makers respond to incoming orders
// Place maker order that fills against pending taker

await driftClient.placeAndMake(
  {
    orderType: OrderType.LIMIT,
    marketIndex: 0,
    direction: PositionDirection.LONG,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(100),
    postOnly: PostOnlyParams.MUST_POST_ONLY,
  },
  {
    taker: takerPubkey,
    takerStats: takerStatsPubkey,
    takerUserAccount,
    order: takerOrder,
  }
);
```

### Floating Maker

Dynamically adjust quotes based on inventory:

```typescript
async function floatingMaker(marketIndex: number) {
  const user = driftClient.getUser();
  const perpPosition = user.getPerpPosition(marketIndex);
  const baseAmount = perpPosition?.baseAssetAmount || new BN(0);

  // Get oracle price
  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  const oraclePrice = convertToNumber(oracleData.price, PRICE_PRECISION);

  // Adjust spread based on inventory
  const inventorySkew = convertToNumber(baseAmount, BASE_PRECISION);
  const baseSpreadBps = 10; // 0.1%

  // Widen spread on side with inventory
  let bidSpread = baseSpreadBps;
  let askSpread = baseSpreadBps;

  if (inventorySkew > 0) {
    // Long inventory - widen bid, tighten ask
    bidSpread = baseSpreadBps * 1.5;
    askSpread = baseSpreadBps * 0.5;
  } else if (inventorySkew < 0) {
    // Short inventory - tighten bid, widen ask
    bidSpread = baseSpreadBps * 0.5;
    askSpread = baseSpreadBps * 1.5;
  }

  const bidPrice = oraclePrice * (1 - bidSpread / 10000);
  const askPrice = oraclePrice * (1 + askSpread / 10000);

  // Cancel existing orders
  await driftClient.cancelOrders(MarketType.PERP, marketIndex);

  // Place new quotes
  await placeQuotes(marketIndex, bidPrice, askPrice, 1);
}
```

## Orderbook Access (DLOB)

### Using UserMap

```typescript
import { UserMap, Orderbook } from '@drift-labs/sdk';

// Subscribe to all users (for orderbook)
const userMap = new UserMap({
  connection,
  driftClient,
  subscriptionConfig: {
    type: 'websocket',
    commitment: 'confirmed',
  },
});

await userMap.subscribe();

// Get orderbook
const perpMarket = driftClient.getPerpMarketAccount(0);
const oracleData = driftClient.getOracleDataForPerpMarket(0);

const dlob = await userMap.getDLOB(
  perpMarket.marketIndex,
  MarketType.PERP,
  oracleData
);

// Get best bid/ask
const bestBid = dlob.getBestBid(0, MarketType.PERP, oracleData);
const bestAsk = dlob.getBestAsk(0, MarketType.PERP, oracleData);
```

### Using DLOB Server

```typescript
// REST API
const response = await fetch(
  'https://dlob.drift.trade/l2?marketIndex=0&marketType=perp'
);
const orderbook = await response.json();

console.log('Bids:', orderbook.bids);
console.log('Asks:', orderbook.asks);
```

## Risk Management

### Position Limits

```typescript
const MAX_POSITION = 10; // 10 SOL max position

async function checkPositionLimit(marketIndex: number): Promise<boolean> {
  const user = driftClient.getUser();
  const position = user.getPerpPosition(marketIndex);
  const currentSize = position
    ? Math.abs(convertToNumber(position.baseAssetAmount, BASE_PRECISION))
    : 0;

  return currentSize < MAX_POSITION;
}
```

### Delta Hedging

```typescript
async function deltaHedge(marketIndex: number) {
  const user = driftClient.getUser();
  const perpPosition = user.getPerpPosition(marketIndex);

  if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) {
    return; // No position to hedge
  }

  // Get current perp delta
  const perpDelta = convertToNumber(perpPosition.baseAssetAmount, BASE_PRECISION);

  // Place opposite spot order to hedge
  const spotDirection = perpDelta > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
  const spotSize = Math.abs(perpDelta);

  await driftClient.placeSpotOrder({
    orderType: OrderType.MARKET,
    marketIndex: 1, // SOL spot
    direction: spotDirection,
    baseAssetAmount: driftClient.convertToSpotPrecision(1, spotSize),
  });
}
```

## Keeper Bots

Drift provides reference implementations for market making bots:

- [keeper-bots-v2](https://github.com/drift-labs/keeper-bots-v2) - TypeScript bots
- JIT Maker bot
- Floating Maker bot
- Filler bot (fills orders against DLOB)

## Best Practices

1. **Use post-only orders** to ensure maker status
2. **Monitor inventory** and adjust quotes accordingly
3. **Set position limits** to manage risk
4. **Track funding rates** for perp positions
5. **Use WebSocket subscriptions** for real-time data
6. **Implement circuit breakers** for high volatility
7. **Test on devnet** before mainnet deployment

## Resources

- [Drift Keeper Bots](https://github.com/drift-labs/keeper-bots-v2)
- [DLOB Server Docs](https://dlob.drift.trade)
- [Market Making Discussion](https://discord.gg/drift)
