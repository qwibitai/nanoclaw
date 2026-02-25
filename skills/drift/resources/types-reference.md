# Drift Protocol Types Reference

Complete reference for all TypeScript types, enums, and interfaces in the Drift SDK.

## Order Types

### OrderType

```typescript
import { OrderType } from '@drift-labs/sdk';

OrderType.MARKET          // Immediate market execution
OrderType.LIMIT           // Price-specific limit order
OrderType.TRIGGER_MARKET  // Conditional market order (stop-loss/take-profit)
OrderType.TRIGGER_LIMIT   // Conditional limit order
OrderType.ORACLE          // Oracle-based pricing with offsets
```

### OrderStatus

```typescript
import { OrderStatus } from '@drift-labs/sdk';

OrderStatus.INIT      // Order initialized
OrderStatus.OPEN      // Active in orderbook
OrderStatus.FILLED    // Completely filled
OrderStatus.CANCELED  // User cancelled
```

### OrderTriggerCondition

```typescript
import { OrderTriggerCondition } from '@drift-labs/sdk';

OrderTriggerCondition.ABOVE           // Trigger when price > threshold
OrderTriggerCondition.BELOW           // Trigger when price < threshold
OrderTriggerCondition.TRIGGERED_ABOVE // Already triggered above
OrderTriggerCondition.TRIGGERED_BELOW // Already triggered below
```

### PostOnlyParams

```typescript
import { PostOnlyParams } from '@drift-labs/sdk';

PostOnlyParams.NONE           // No enforcement (can be taker or maker)
PostOnlyParams.MUST_POST_ONLY // Fail if order would cross spread
PostOnlyParams.TRY_POST_ONLY  // Skip order if would cross (no fail)
PostOnlyParams.SLIDE          // Adjust price to be post-only
```

## Position & Direction Types

### PositionDirection

```typescript
import { PositionDirection } from '@drift-labs/sdk';

PositionDirection.LONG   // Buy/bid direction
PositionDirection.SHORT  // Sell/ask direction
```

### MarketType

```typescript
import { MarketType } from '@drift-labs/sdk';

MarketType.PERP  // Perpetual futures market
MarketType.SPOT  // Spot market
```

### SpotBalanceType

```typescript
import { SpotBalanceType } from '@drift-labs/sdk';

SpotBalanceType.DEPOSIT  // Deposited tokens
SpotBalanceType.BORROW   // Borrowed tokens
```

## Market Status Types

### MarketStatus

```typescript
import { MarketStatus } from '@drift-labs/sdk';

MarketStatus.INITIALIZED     // Market created
MarketStatus.ACTIVE          // Normal operation
MarketStatus.FUNDING_PAUSED  // Funding payments paused
MarketStatus.AMM_PAUSED      // AMM operations paused
MarketStatus.FILL_PAUSED     // Order fills paused
MarketStatus.WITHDRAW_PAUSED // Withdrawals paused
MarketStatus.REDUCE_ONLY     // Only reduce positions allowed
MarketStatus.SETTLEMENT      // Market in settlement
MarketStatus.DELISTED        // Market removed
```

### ContractType

```typescript
import { ContractType } from '@drift-labs/sdk';

ContractType.PERPETUAL   // Standard perpetual contract
ContractType.FUTURE      // Dated future (not commonly used)
ContractType.PREDICTION  // Prediction market
```

### ContractTier

```typescript
import { ContractTier } from '@drift-labs/sdk';

ContractTier.A                  // Highest tier
ContractTier.B                  // Second tier
ContractTier.C                  // Third tier
ContractTier.SPECULATIVE        // Speculative assets
ContractTier.HIGHLY_SPECULATIVE // High-risk assets
ContractTier.ISOLATED           // Isolated margin only
```

### AssetTier

```typescript
import { AssetTier } from '@drift-labs/sdk';

AssetTier.COLLATERAL  // Full collateral support
AssetTier.PROTECTED   // Protected collateral
AssetTier.CROSS       // Cross-margin eligible
AssetTier.ISOLATED    // Isolated margin only
AssetTier.UNLISTED    // Not usable as collateral
```

## Oracle Types

### OracleSource

```typescript
import { OracleSource } from '@drift-labs/sdk';

OracleSource.PYTH                    // Standard Pyth oracle
OracleSource.PYTH_1K                 // Pyth with 1K multiplier
OracleSource.PYTH_1M                 // Pyth with 1M multiplier
OracleSource.PYTH_PULL               // Pyth pull oracle
OracleSource.PYTH_1K_PULL            // Pyth 1K pull
OracleSource.PYTH_1M_PULL            // Pyth 1M pull
OracleSource.SWITCHBOARD             // Switchboard oracle
OracleSource.QUOTE_ASSET             // Quote asset (always $1)
OracleSource.PYTH_STABLE_COIN        // Pyth stablecoin
OracleSource.PYTH_STABLE_COIN_PULL   // Pyth stablecoin pull
OracleSource.PRELAUNCH               // Pre-launch oracle
OracleSource.SWITCHBOARD_ON_DEMAND   // Switchboard on-demand
OracleSource.PYTH_LAZER              // Pyth Lazer oracle
OracleSource.PYTH_LAZER_1K           // Pyth Lazer 1K
OracleSource.PYTH_LAZER_1M           // Pyth Lazer 1M
OracleSource.PYTH_LAZER_STABLE_COIN  // Pyth Lazer stablecoin
```

### OracleValidity

```typescript
enum OracleValidity {
  NonPositive = 0,
  TooVolatile = 1,
  TooUncertain = 2,
  StaleForMargin = 3,
  InsufficientDataPoints = 4,
  StaleForAMMLowRisk = 5,
  StaleForAmmImmediate = 6,
  Valid = 7,
}
```

## Account Types

### UserAccount

```typescript
interface UserAccount {
  authority: PublicKey;
  delegate: PublicKey;
  name: number[];              // 32-byte name
  subAccountId: number;
  spotPositions: SpotPosition[];
  perpPositions: PerpPosition[];
  orders: Order[];
  status: UserStatus;
  nextLiquidationId: number;
  nextOrderId: number;
  maxMarginRatio: number;
  lastAddPerpLpSharesTs: BN;
  settledPerpPnl: BN;
  totalDeposits: BN;
  totalWithdraws: BN;
  totalSocialLoss: BN;
  cumulativePerpFunding: BN;
  cumulativeSpotFees: BN;
  liquidationMarginFreed: BN;
  lastActiveSlot: BN;
  isMarginTradingEnabled: boolean;
  idle: boolean;
  openOrders: number;
  hasOpenOrder: boolean;
  openAuctions: number;
  hasOpenAuction: boolean;
  lastFuelBonusUpdateTs: BN;
  marginMode: MarginMode;
  poolId: number;
}
```

### PerpPosition

```typescript
interface PerpPosition {
  baseAssetAmount: BN;              // Positive = long, negative = short
  lastCumulativeFundingRate: BN;
  marketIndex: number;
  quoteAssetAmount: BN;
  quoteEntryAmount: BN;
  quoteBreakEvenAmount: BN;
  openOrders: number;
  openBids: BN;
  openAsks: BN;
  settledPnl: BN;
  lpShares: BN;
  maxMarginRatio: number;
  lastQuoteAssetAmountPerLp: BN;
  perLpBase: number;
  isolatedPositionScaledBalance: BN;
  positionFlag: number;
}
```

### SpotPosition

```typescript
interface SpotPosition {
  marketIndex: number;
  balanceType: SpotBalanceType;
  scaledBalance: BN;
  openOrders: number;
  openBids: BN;
  openAsks: BN;
  cumulativeDeposits: BN;
}
```

### Order

```typescript
interface Order {
  status: OrderStatus;
  orderType: OrderType;
  marketType: MarketType;
  slot: BN;
  orderId: number;
  userOrderId: number;
  marketIndex: number;
  price: BN;
  baseAssetAmount: BN;
  quoteAssetAmount: BN;
  baseAssetAmountFilled: BN;
  quoteAssetAmountFilled: BN;
  direction: PositionDirection;
  reduceOnly: boolean;
  triggerPrice: BN;
  triggerCondition: OrderTriggerCondition;
  existingPositionDirection: PositionDirection;
  postOnly: boolean;
  immediateOrCancel: boolean;
  oraclePriceOffset: number;
  auctionDuration: number;
  auctionStartPrice: BN;
  auctionEndPrice: BN;
  maxTs: BN;
  bitFlags: number;
  postedSlotTail: number;
}
```

## Order Parameters

### OrderParams

```typescript
interface OrderParams {
  orderType: OrderType;
  marketType?: MarketType;           // Default: PERP for perp, SPOT for spot
  marketIndex: number;
  direction: PositionDirection;
  baseAssetAmount: BN;
  price?: BN;                        // Required for LIMIT orders
  userOrderId?: number;              // Custom ID for tracking
  reduceOnly?: boolean;              // Only reduce position
  postOnly?: PostOnlyParams;         // Maker-only enforcement
  triggerPrice?: BN;                 // For TRIGGER orders
  triggerCondition?: OrderTriggerCondition;
  oraclePriceOffset?: number;        // For ORACLE orders
  auctionDuration?: number;          // Auction slots
  auctionStartPrice?: BN;
  auctionEndPrice?: BN;
  maxTs?: BN;                        // Order expiration timestamp
}
```

### ModifyOrderParams

```typescript
interface ModifyOrderParams {
  baseAssetAmount?: BN;
  direction?: PositionDirection;
  price?: BN;
  reduceOnly?: boolean;
  postOnly?: PostOnlyParams;
  triggerPrice?: BN;
  triggerCondition?: OrderTriggerCondition;
  oraclePriceOffset?: number;
  auctionDuration?: number;
  auctionStartPrice?: BN;
  auctionEndPrice?: BN;
  maxTs?: BN;
  policy?: ModifyOrderPolicy;
}
```

## Market Account Types

### PerpMarketAccount

```typescript
interface PerpMarketAccount {
  marketIndex: number;
  status: MarketStatus;
  contractType: ContractType;
  contractTier: ContractTier;
  name: number[];
  amm: AMM;
  // ... additional fields
}
```

### SpotMarketAccount

```typescript
interface SpotMarketAccount {
  marketIndex: number;
  status: MarketStatus;
  assetTier: AssetTier;
  name: number[];
  decimals: number;
  mint: PublicKey;
  vault: PublicKey;
  // ... additional fields
}
```

## Margin Types

### MarginCategory

```typescript
import { MarginCategory } from '@drift-labs/sdk';

MarginCategory.INITIAL      // For opening/increasing positions
MarginCategory.MAINTENANCE  // For liquidation checks
```

## Event Types

### Event Type Strings

```typescript
type DriftEventType =
  | 'DepositRecord'
  | 'FundingPaymentRecord'
  | 'LiquidationRecord'
  | 'OrderRecord'
  | 'OrderActionRecord'
  | 'FundingRateRecord'
  | 'NewUserRecord'
  | 'SettlePnlRecord'
  | 'LPRecord'
  | 'InsuranceFundRecord'
  | 'SpotInterestRecord'
  | 'InsuranceFundStakeRecord'
  | 'CurveRecord';
```

## Utility Types

### DataAndSlot

```typescript
interface DataAndSlot<T> {
  data: T;
  slot: number;
}
```

### TxParams

```typescript
interface TxParams {
  computeUnits?: number;
  computeUnitsPrice?: number;
  cuPriceMicroLamports?: number;
}
```

### ReferrerInfo

```typescript
interface ReferrerInfo {
  referrer: PublicKey;
  referrerStats: PublicKey;
}
```
