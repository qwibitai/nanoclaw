# User Class API Reference

Complete reference for the User class methods used for account queries and calculations.

## Subscription & Account Access

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `subscribe` | `userAccount?` | `Promise<boolean>` | Subscribe to updates |
| `fetchAccounts` | - | `Promise<void>` | Force fetch from RPC |
| `unsubscribe` | - | `Promise<void>` | Unsubscribe |
| `exists` | - | `Promise<boolean>` | Check if account exists |
| `getUserAccount` | - | `UserAccount` | Get account data |
| `forceGetUserAccount` | - | `Promise<UserAccount>` | Fetch from RPC |
| `getUserAccountAndSlot` | - | `DataAndSlot<UserAccount>` | Get with slot |
| `getUserAccountPublicKey` | - | `PublicKey` | Get account pubkey |

## Position Retrieval

### Perpetual Positions

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPerpPosition` | `marketIndex` | `PerpPosition \| undefined` | Get perp position |
| `getPerpPositionOrEmpty` | `marketIndex` | `PerpPosition` | Get or empty position |
| `getPerpPositionAndSlot` | `marketIndex` | `DataAndSlot<PerpPosition>` | Get with slot |
| `getActivePerpPositions` | - | `PerpPosition[]` | Get all active positions |
| `getActivePerpPositionsAndSlot` | - | `DataAndSlot<PerpPosition[]>` | Get with slot |
| `isPositionEmpty` | `position` | `boolean` | Check if position empty |
| `getPositionSide` | `position` | `PositionDirection \| undefined` | Get long/short |

### Spot Positions

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getSpotPosition` | `marketIndex` | `SpotPosition \| undefined` | Get spot position |
| `getSpotPositionAndSlot` | `marketIndex` | `DataAndSlot<SpotPosition>` | Get with slot |
| `getActiveSpotPositions` | - | `SpotPosition[]` | Get all active positions |
| `getActiveSpotPositionsAndSlot` | - | `DataAndSlot<SpotPosition[]>` | Get with slot |

## Token & Balance

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getTokenAmount` | `marketIndex` | `BN` | Signed token amount (+ deposit, - borrow) |
| `getIsolatePerpPositionTokenAmount` | `perpMarketIndex` | `BN` | Isolated position balance |

## Order Management

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getOrder` | `orderId` | `Order \| undefined` | Get order by ID |
| `getOrderAndSlot` | `orderId` | `DataAndSlot<Order>` | Get with slot |
| `getOrderByUserOrderId` | `userOrderId` | `Order \| undefined` | Get by user ID |
| `getOrderByUserOrderIdAndSlot` | `userOrderId` | `DataAndSlot<Order>` | Get with slot |
| `getOpenOrders` | - | `Order[]` | Get all open orders |
| `getOpenOrdersAndSlot` | - | `DataAndSlot<Order[]>` | Get with slot |

## Collateral & Margin

### Collateral Queries

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getTotalCollateral` | `marginCategory?, strict?, includeOpenOrders?, liquidationBuffer?, perpMarketIndex?` | `BN` | Total collateral value |
| `getFreeCollateral` | `marginCategory?, enterHighLeverageMode?, perpMarketIndex?` | `BN` | Available collateral |

### Margin Requirements

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getMarginRequirement` | `marginCategory, liquidationBuffer?, strict?, includeOpenOrders?, enteringHighLeverage?, perpMarketIndex?` | `BN` | Total margin required |
| `getInitialMarginRequirement` | `enterHighLeverageMode?, perpMarketIndex?` | `BN` | Initial margin |
| `getMaintenanceMarginRequirement` | `liquidationBuffer?, perpMarketIndex?` | `BN` | Maintenance margin |
| `getMarginRatio` | - | `BN` | Current margin ratio |

## PnL Calculations

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getUnrealizedPNL` | `withFunding?, marketIndex?, withWeightMarginCategory?, strict?, liquidationBuffer?` | `BN` | Unrealized PnL |
| `getUnrealizedFundingPNL` | `marketIndex?` | `BN` | Unrealized funding PnL |
| `getTotalAllTimePnl` | - | `BN` | All-time realized PnL |
| `needsToSettleFundingPayment` | - | `boolean` | Check if needs settlement |

## Value Calculations

### Net Value

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getNetUsdValue` | - | `BN` | Total USD value |
| `getTotalAssetValue` | `marginCategory?` | `BN` | Total assets |
| `getTotalLiabilityValue` | `marginCategory?` | `BN` | Total liabilities |

### Perp Values

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPerpPositionValue` | `marketIndex, oraclePriceData, includeOpenOrders?` | `BN` | Position value |
| `getPerpLiabilityValue` | `marketIndex, oraclePriceData, includeOpenOrders?` | `BN` | Position liability |
| `getPerpMarketLiabilityValue` | `marketIndex, marginCategory?, liquidationBuffer?, includeOpenOrders?, strict?` | `BN` | Market liability |

### Spot Values

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getSpotPositionValue` | `marketIndex, marginCategory?, includeOpenOrders?, strict?, now?` | `BN` | Position value |
| `getSpotMarketAssetValue` | `marketIndex?, marginCategory?, includeOpenOrders?, strict?, now?` | `BN` | Asset value |
| `getSpotMarketLiabilityValue` | `marketIndex?, marginCategory?, liquidationBuffer?, includeOpenOrders?, strict?, now?` | `BN` | Liability value |
| `getNetSpotMarketValue` | `withWeightMarginCategory?` | `BN` | Net spot value |

## Leverage & Health

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getLeverage` | `includeOpenOrders?, perpMarketIndex?` | `BN` | Current leverage |
| `getHealth` | `perpMarketIndex?` | `number` | Health (0-100) |
| `getMaxLeverageForPerp` | `perpMarketIndex, marginCategory?, isLp?, enterHighLeverageMode?` | `BN` | Max perp leverage |
| `getMaxLeverageForSpot` | `spotMarketIndex, direction` | `BN` | Max spot leverage |
| `isHighLeverageMode` | `marginCategory` | `boolean` | Check high leverage |

## Buying Power & Trade Sizing

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPerpBuyingPower` | `marketIndex, collateralBuffer?, enterHighLeverageMode?, maxMarginRatio?, positionType?` | `BN` | Perp buying power |
| `getMaxTradeSizeUSDCForPerp` | `targetMarketIndex, tradeSide, isLp?, enterHighLeverageMode?, maxMarginRatio?, positionType?` | `{tradeSize, oppositeSideTradeSize}` | Max perp trade size |
| `getMaxTradeSizeUSDCForSpot` | `targetMarketIndex, direction, currentQuoteAssetValue?, currentSpotMarketNetValue?` | `BN` | Max spot trade size |
| `getMaxSwapAmount` | `{inMarketIndex, outMarketIndex, inAmount?, outAmount?}` | `{inAmount, outAmount, leverage}` | Max swap amounts |

## Liquidation Analysis

### Liquidation Status

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `canBeLiquidated` | - | `AccountLiquidatableStatus & {isolatedPositions}` | Check liquidation risk |
| `getLiquidationStatuses` | `marginCalc?` | `Map<'cross' \| number, AccountLiquidatableStatus>` | All liquidation statuses |
| `isBeingLiquidated` | - | `boolean` | Currently liquidating |
| `isBankrupt` | - | `boolean` | Is bankrupt |

### Liquidation Prices

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `liquidationPrice` | `marketIndex, positionBaseSizeChange?, estimatedEntryPrice?, marginCategory?, includeOpenOrders?, offsetCollateral?, enteringHighLeverage?, marginType?` | `BN` | Perp liquidation price |
| `liquidationPriceAfterClose` | `positionMarketIndex, closeQuoteAmount, estimatedEntryPrice?` | `BN` | Liq price after close |
| `spotLiquidationPrice` | `marketIndex, positionBaseSizeChange?` | `BN` | Spot liquidation price |

### Isolated Positions

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `canCrossMarginBeLiquidated` | `marginCalc?` | `boolean` | Cross margin liq risk |
| `hasIsolatedPositionBeingLiquidated` | - | `boolean` | Any isolated liquidating |
| `isIsolatedPositionBeingLiquidated` | `perpMarketIndex` | `boolean` | Specific isolated liq |
| `getLiquidatableIsolatedPositions` | `marginCalc?` | `number[]` | List of liquidatable |

## Position Analysis

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPositionEstimatedExitPriceAndPnl` | `position, amountToClose?, useAMMClose?` | `[BN, BN]` | Exit price and PnL |
| `getPerpBidAsks` | `marketIndex` | `[BN, BN]` | Position bid/ask |

## Trading Simulation

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `accountLeverageAfterSwap` | `{inMarketIndex, outMarketIndex, inAmount, outAmount}` | `BN` | Leverage after swap |
| `accountLeverageRatioAfterTrade` | `targetMarketIndex, targetMarketType, tradeQuoteAmount, tradeSide, includeOpenOrders?` | `BN` | Leverage after trade |

## Margin Requirements for Trades

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getMarginUSDCRequiredForTrade` | `targetMarketIndex, baseSize, estEntryPrice?, perpMarketMaxMarginRatio?` | `BN` | USDC margin for trade |
| `getCollateralDepositRequiredForTrade` | `targetMarketIndex, baseSize, collateralIndex, perpMarketMaxMarginRatio?` | `BN` | Collateral for trade |

## Fuel & Rewards

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getFuelBonus` | `now, includeSettled?, includeUnsettled?, givenUserStats?` | `{depositFuel, borrowFuel, positionFuel, takerFuel, makerFuel, insuranceFuel}` | Get fuel bonuses |

## Status Checks

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `hasStatus` | `status` | `boolean` | Check user status |
| `isBankrupt` | - | `boolean` | Is bankrupt |

## Usage Examples

### Get Account Overview

```typescript
const user = driftClient.getUser();

// Account health
const health = user.getHealth();
const leverage = user.getLeverage();
const freeCollateral = user.getFreeCollateral();

console.log(`Health: ${health}%`);
console.log(`Leverage: ${convertToNumber(leverage, MARGIN_PRECISION)}x`);
console.log(`Free Collateral: $${convertToNumber(freeCollateral, QUOTE_PRECISION)}`);
```

### Check Position

```typescript
const user = driftClient.getUser();
const perpPosition = user.getPerpPosition(0);

if (perpPosition && !user.isPositionEmpty(perpPosition)) {
  const side = user.getPositionSide(perpPosition);
  const pnl = user.getUnrealizedPNL(false, 0);
  const liqPrice = user.liquidationPrice(0);

  console.log(`Side: ${side === PositionDirection.LONG ? 'Long' : 'Short'}`);
  console.log(`Size: ${convertToNumber(perpPosition.baseAssetAmount, BASE_PRECISION)}`);
  console.log(`Unrealized PnL: $${convertToNumber(pnl, QUOTE_PRECISION)}`);
  console.log(`Liquidation Price: $${convertToNumber(liqPrice, PRICE_PRECISION)}`);
}
```

### Calculate Trade Size

```typescript
const user = driftClient.getUser();

// Get max trade size for SOL-PERP
const { tradeSize } = user.getMaxTradeSizeUSDCForPerp(
  0, // SOL-PERP
  PositionDirection.LONG
);

console.log(`Max long size: $${convertToNumber(tradeSize, QUOTE_PRECISION)}`);

// Check margin required
const marginRequired = user.getMarginUSDCRequiredForTrade(
  0,
  driftClient.convertToPerpPrecision(1) // 1 SOL
);

console.log(`Margin for 1 SOL: $${convertToNumber(marginRequired, QUOTE_PRECISION)}`);
```
