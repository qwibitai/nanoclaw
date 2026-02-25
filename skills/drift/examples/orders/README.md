# Order Examples

## Market Orders

### Perpetual Market Order

```typescript
import {
  OrderType,
  PositionDirection,
  BASE_PRECISION,
} from '@drift-labs/sdk';

// Long 1 SOL at market price
await driftClient.placePerpOrder({
  orderType: OrderType.MARKET,
  marketIndex: 0, // SOL-PERP
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
});

// Short 0.5 SOL at market price
await driftClient.placePerpOrder({
  orderType: OrderType.MARKET,
  marketIndex: 0,
  direction: PositionDirection.SHORT,
  baseAssetAmount: driftClient.convertToPerpPrecision(0.5),
});
```

### Spot Market Order

```typescript
// Buy 1 SOL
await driftClient.placeSpotOrder({
  orderType: OrderType.MARKET,
  marketIndex: 1, // SOL
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
});

// Sell 1 SOL
await driftClient.placeSpotOrder({
  orderType: OrderType.MARKET,
  marketIndex: 1,
  direction: PositionDirection.SHORT,
  baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
});
```

## Limit Orders

### Basic Limit Order

```typescript
// Long 1 SOL at $100
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100),
});
```

### Post-Only Limit Order (Maker Only)

```typescript
import { PostOnlyParams } from '@drift-labs/sdk';

// Must be maker, fail if would cross spread
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(99),
  postOnly: PostOnlyParams.MUST_POST_ONLY,
});

// Try to be maker, skip if would cross
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(99),
  postOnly: PostOnlyParams.TRY_POST_ONLY,
});

// Slide price to be maker
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100),
  postOnly: PostOnlyParams.SLIDE,
});
```

### Limit Order with Expiration

```typescript
// Order expires in 1 hour
const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600;

await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100),
  maxTs: new BN(oneHourFromNow),
});
```

## Stop-Loss & Take-Profit Orders

### Stop-Loss (Trigger Market)

```typescript
import { OrderTriggerCondition } from '@drift-labs/sdk';

// Stop-loss for long position: sell if price drops below $90
await driftClient.placePerpOrder({
  orderType: OrderType.TRIGGER_MARKET,
  marketIndex: 0,
  direction: PositionDirection.SHORT, // Close long
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  triggerPrice: driftClient.convertToPricePrecision(90),
  triggerCondition: OrderTriggerCondition.BELOW,
  reduceOnly: true,
});

// Stop-loss for short position: buy if price rises above $110
await driftClient.placePerpOrder({
  orderType: OrderType.TRIGGER_MARKET,
  marketIndex: 0,
  direction: PositionDirection.LONG, // Close short
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  triggerPrice: driftClient.convertToPricePrecision(110),
  triggerCondition: OrderTriggerCondition.ABOVE,
  reduceOnly: true,
});
```

### Take-Profit (Trigger Limit)

```typescript
// Take-profit for long: sell at $120 when price reaches $120
await driftClient.placePerpOrder({
  orderType: OrderType.TRIGGER_LIMIT,
  marketIndex: 0,
  direction: PositionDirection.SHORT,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(120),
  triggerPrice: driftClient.convertToPricePrecision(120),
  triggerCondition: OrderTriggerCondition.ABOVE,
  reduceOnly: true,
});
```

## Oracle Orders

```typescript
// Buy at $0.10 below oracle price
await driftClient.placePerpOrder({
  orderType: OrderType.ORACLE,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  oraclePriceOffset: -100000, // -$0.10 (PRICE_PRECISION)
  auctionDuration: 10, // 10 slots
  auctionStartPrice: new BN(-200000), // Start $0.20 below
  auctionEndPrice: new BN(-50000), // End $0.05 below
});
```

## Multiple Orders

```typescript
import { MarketType } from '@drift-labs/sdk';

// Place bid and ask simultaneously
await driftClient.placeOrders([
  {
    orderType: OrderType.LIMIT,
    marketType: MarketType.PERP,
    marketIndex: 0,
    direction: PositionDirection.LONG,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(99),
    postOnly: PostOnlyParams.MUST_POST_ONLY,
  },
  {
    orderType: OrderType.LIMIT,
    marketType: MarketType.PERP,
    marketIndex: 0,
    direction: PositionDirection.SHORT,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(101),
    postOnly: PostOnlyParams.MUST_POST_ONLY,
  },
]);
```

## Order Management

### Cancel Orders

```typescript
// Cancel by order ID
await driftClient.cancelOrder(orderId);

// Cancel by user order ID
await driftClient.cancelOrderByUserOrderId(userOrderId);

// Cancel all perp orders for SOL-PERP
await driftClient.cancelOrders(MarketType.PERP, 0);

// Cancel all long orders for SOL-PERP
await driftClient.cancelOrders(MarketType.PERP, 0, PositionDirection.LONG);

// Cancel all orders
await driftClient.cancelOrders();
```

### Modify Orders

```typescript
// Modify price
await driftClient.modifyOrder(orderId, {
  price: driftClient.convertToPricePrecision(102),
});

// Modify size
await driftClient.modifyOrder(orderId, {
  baseAssetAmount: driftClient.convertToPerpPrecision(2),
});

// Modify multiple parameters
await driftClient.modifyOrder(orderId, {
  price: driftClient.convertToPricePrecision(102),
  baseAssetAmount: driftClient.convertToPerpPrecision(2),
  postOnly: PostOnlyParams.MUST_POST_ONLY,
});
```

### Cancel and Replace

```typescript
// Atomic cancel and place new orders
await driftClient.cancelAndPlaceOrders({
  cancelOrderParams: { orderId: existingOrderId },
  placeOrderParams: [{
    orderType: OrderType.LIMIT,
    marketType: MarketType.PERP,
    marketIndex: 0,
    direction: PositionDirection.LONG,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(100),
  }],
});
```

### Query Orders

```typescript
const user = driftClient.getUser();

// Get all open orders
const openOrders = user.getOpenOrders();
console.log('Open orders:', openOrders.length);

// Get specific order
const order = driftClient.getOrder(orderId);
if (order) {
  console.log('Order status:', order.status);
  console.log('Filled:', order.baseAssetAmountFilled.toString());
}
```

## Python Examples

```python
from driftpy.types import OrderType, PositionDirection, OrderTriggerCondition

# Market order
await drift_client.place_perp_order(
    order_type=OrderType.MARKET(),
    market_index=0,
    direction=PositionDirection.LONG(),
    base_asset_amount=drift_client.convert_to_perp_precision(1),
)

# Limit order
await drift_client.place_perp_order(
    order_type=OrderType.LIMIT(),
    market_index=0,
    direction=PositionDirection.LONG(),
    base_asset_amount=drift_client.convert_to_perp_precision(1),
    price=drift_client.convert_to_price_precision(100),
)

# Stop-loss
await drift_client.place_perp_order(
    order_type=OrderType.TRIGGER_MARKET(),
    market_index=0,
    direction=PositionDirection.SHORT(),
    base_asset_amount=drift_client.convert_to_perp_precision(1),
    trigger_price=drift_client.convert_to_price_precision(90),
    trigger_condition=OrderTriggerCondition.BELOW(),
    reduce_only=True,
)

# Cancel order
await drift_client.cancel_order(order_id)
```
