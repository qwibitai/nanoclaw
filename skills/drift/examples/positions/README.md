# Position Management Examples

## Reading Perpetual Positions

### Get Position Details

```typescript
import {
  PositionDirection,
  BASE_PRECISION,
  QUOTE_PRECISION,
  PRICE_PRECISION,
  convertToNumber,
} from '@drift-labs/sdk';

const user = driftClient.getUser();

// Get SOL-PERP position
const perpPosition = user.getPerpPosition(0);

if (perpPosition && perpPosition.baseAssetAmount.abs().gt(new BN(0))) {
  // Position exists
  const baseAmount = perpPosition.baseAssetAmount;
  const side = user.getPositionSide(perpPosition);

  console.log('Position side:', side === PositionDirection.LONG ? 'Long' : 'Short');
  console.log('Size:', convertToNumber(baseAmount.abs(), BASE_PRECISION), 'SOL');

  // Entry price (quote / base)
  const entryPrice = perpPosition.quoteEntryAmount.abs()
    .mul(BASE_PRECISION)
    .div(baseAmount.abs());
  console.log('Entry price:', convertToNumber(entryPrice, QUOTE_PRECISION));

  // Break-even price
  const breakEvenPrice = perpPosition.quoteBreakEvenAmount.abs()
    .mul(BASE_PRECISION)
    .div(baseAmount.abs());
  console.log('Break-even:', convertToNumber(breakEvenPrice, QUOTE_PRECISION));
}
```

### Get All Active Perp Positions

```typescript
const user = driftClient.getUser();
const positions = user.getActivePerpPositions();

for (const pos of positions) {
  const market = driftClient.getPerpMarketAccount(pos.marketIndex);
  const marketName = String.fromCharCode(...market.name.filter(c => c !== 0));

  const side = pos.baseAssetAmount.gt(new BN(0)) ? 'Long' : 'Short';
  const size = convertToNumber(pos.baseAssetAmount.abs(), BASE_PRECISION);

  console.log(`${marketName}: ${side} ${size}`);
}
```

## PnL Calculations

### Unrealized PnL

```typescript
const user = driftClient.getUser();

// Total unrealized PnL (all positions)
const totalPnl = user.getUnrealizedPNL();
console.log('Total PnL:', convertToNumber(totalPnl, QUOTE_PRECISION), 'USDC');

// PnL with funding included
const pnlWithFunding = user.getUnrealizedPNL(true);
console.log('PnL with funding:', convertToNumber(pnlWithFunding, QUOTE_PRECISION));

// PnL for specific market
const solPnl = user.getUnrealizedPNL(false, 0);
console.log('SOL-PERP PnL:', convertToNumber(solPnl, QUOTE_PRECISION));
```

### Funding PnL

```typescript
const user = driftClient.getUser();

// Total unrealized funding payments
const fundingPnl = user.getUnrealizedFundingPNL();
console.log('Funding PnL:', convertToNumber(fundingPnl, QUOTE_PRECISION));

// Funding for specific market
const solFunding = user.getUnrealizedFundingPNL(0);
console.log('SOL funding:', convertToNumber(solFunding, QUOTE_PRECISION));

// Check if needs to settle
if (user.needsToSettleFundingPayment()) {
  console.log('Has unsettled funding payments');
}
```

### Settle PnL

```typescript
const user = driftClient.getUser();

// Settle PnL to realize gains/losses
await driftClient.settlePNL(
  user.getUserAccountPublicKey(),
  user.getUserAccount(),
  0 // SOL-PERP market index
);
```

## Collateral and Margin

### Get Collateral Values

```typescript
const user = driftClient.getUser();

// Total collateral (all assets weighted)
const totalCollateral = user.getTotalCollateral();
console.log('Total collateral:', convertToNumber(totalCollateral, QUOTE_PRECISION));

// Free collateral (available for trading)
const freeCollateral = user.getFreeCollateral();
console.log('Free collateral:', convertToNumber(freeCollateral, QUOTE_PRECISION));

// Total asset value
const assetValue = user.getTotalAssetValue();
console.log('Asset value:', convertToNumber(assetValue, QUOTE_PRECISION));

// Total liability value
const liabilityValue = user.getTotalLiabilityValue();
console.log('Liability value:', convertToNumber(liabilityValue, QUOTE_PRECISION));

// Net USD value
const netValue = user.getNetUsdValue();
console.log('Net value:', convertToNumber(netValue, QUOTE_PRECISION));
```

### Margin Requirements

```typescript
import { MarginCategory } from '@drift-labs/sdk';

const user = driftClient.getUser();

// Initial margin (for opening positions)
const initialMargin = user.getMarginRequirement(MarginCategory.INITIAL);
console.log('Initial margin:', convertToNumber(initialMargin, QUOTE_PRECISION));

// Maintenance margin (for liquidation)
const maintenanceMargin = user.getMarginRequirement(MarginCategory.MAINTENANCE);
console.log('Maintenance margin:', convertToNumber(maintenanceMargin, QUOTE_PRECISION));
```

## Leverage and Health

### Account Leverage

```typescript
import { MARGIN_PRECISION } from '@drift-labs/sdk';

const user = driftClient.getUser();

// Current leverage
const leverage = user.getLeverage();
console.log('Leverage:', convertToNumber(leverage, MARGIN_PRECISION), 'x');

// Max leverage for specific market
const maxLeverage = user.getMaxLeverageForPerp(0);
console.log('Max SOL leverage:', convertToNumber(maxLeverage, MARGIN_PRECISION), 'x');
```

### Account Health

```typescript
const user = driftClient.getUser();

// Health percentage (0 = liquidation, 100 = safe)
const health = user.getHealth();
console.log('Health:', health, '%');

// Can be liquidated?
const liquidatable = user.canBeLiquidated();
console.log('Can be liquidated:', liquidatable.canBeLiquidated);
```

## Liquidation Price

### Calculate Liquidation Price

```typescript
const user = driftClient.getUser();

// Get liquidation price for current position
const liqPrice = user.liquidationPrice(0); // SOL-PERP
console.log('Liquidation price:', convertToNumber(liqPrice, PRICE_PRECISION));

// Liquidation price after adding to position
const liqPriceAfterAdd = user.liquidationPrice(
  0,
  driftClient.convertToPerpPrecision(1) // Adding 1 SOL long
);

// Liquidation price after close
const liqPriceAfterClose = user.liquidationPriceAfterClose(
  0,
  driftClient.convertToSpotPrecision(0, 100), // Close $100 worth
  driftClient.convertToPricePrecision(150) // Estimated exit price
);
```

## Trade Sizing

### Max Trade Size

```typescript
const user = driftClient.getUser();

// Max trade size in USDC for SOL-PERP long
const { tradeSize, oppositeSideTradeSize } = user.getMaxTradeSizeUSDCForPerp(
  0, // SOL-PERP
  PositionDirection.LONG
);

console.log('Max long size:', convertToNumber(tradeSize, QUOTE_PRECISION), 'USDC');
console.log('Max short size:', convertToNumber(oppositeSideTradeSize, QUOTE_PRECISION));
```

### Buying Power

```typescript
const user = driftClient.getUser();

// Perp buying power
const buyingPower = user.getPerpBuyingPower(0);
console.log('Buying power:', convertToNumber(buyingPower, QUOTE_PRECISION), 'USDC');
```

### Margin Required for Trade

```typescript
const user = driftClient.getUser();

// How much USDC margin needed for 1 SOL long?
const marginRequired = user.getMarginUSDCRequiredForTrade(
  0, // SOL-PERP
  driftClient.convertToPerpPrecision(1), // 1 SOL
  driftClient.convertToPricePrecision(150) // Estimated entry price
);

console.log('Margin required:', convertToNumber(marginRequired, QUOTE_PRECISION), 'USDC');
```

## Simulate Trades

### Leverage After Trade

```typescript
const user = driftClient.getUser();

// What will leverage be after this trade?
const leverageAfter = user.accountLeverageRatioAfterTrade(
  0, // SOL-PERP
  MarketType.PERP,
  driftClient.convertToSpotPrecision(0, 1000), // $1000 trade
  PositionDirection.LONG
);

console.log('Leverage after trade:', convertToNumber(leverageAfter, MARGIN_PRECISION), 'x');
```

## Python Examples

```python
from driftpy.constants.numeric_constants import (
    BASE_PRECISION,
    QUOTE_PRECISION,
    PRICE_PRECISION,
)

user = drift_client.get_user()

# Get position
perp_position = user.get_perp_position(0)
if perp_position:
    size = perp_position.base_asset_amount / BASE_PRECISION
    print(f"Position size: {size} SOL")

# PnL
pnl = user.get_unrealized_pnl()
print(f"Unrealized PnL: ${pnl / QUOTE_PRECISION:.2f}")

# Health
health = user.get_health()
print(f"Health: {health}%")

# Liquidation price
liq_price = user.liquidation_price(0)
print(f"Liquidation price: ${liq_price / PRICE_PRECISION:.2f}")
```
