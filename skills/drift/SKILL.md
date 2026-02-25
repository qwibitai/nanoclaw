---
name: drift
creator: raunit-dev
description: Complete Drift Protocol SDK for building perpetual futures, spot trading, and DeFi applications on Solana. Use when building trading bots, integrating Drift markets, managing positions, or working with vaults.
---

# Drift Protocol SDK Development Guide

A comprehensive guide for building Solana applications with the Drift Protocol SDK - the leading perpetual futures and spot trading protocol on Solana.

## Overview

Drift Protocol is a decentralized exchange on Solana offering:
- **Perpetual Futures**: Up to 20x leverage on crypto assets
- **Spot Trading**: Borrow/lend and margin trading
- **Cross-Collateral**: Use multiple assets as collateral
- **Vaults**: Delegated trading pools
- **Jupiter Integration**: Direct spot swaps

## Quick Start

### Installation

```bash
npm install @drift-labs/sdk @solana/web3.js @coral-xyz/anchor
```

For Python:
```bash
pip install driftpy
```

### Basic Setup (TypeScript)

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DriftClient,
  initialize,
  DriftEnv,
  BulkAccountLoader
} from '@drift-labs/sdk';

// 1. Setup connection and wallet
const connection = new Connection('https://api.mainnet-beta.solana.com');
const keypair = Keypair.fromSecretKey(/* your secret key */);
const wallet = new Wallet(keypair);

// 2. Initialize SDK
const sdkConfig = initialize({ env: 'mainnet-beta' as DriftEnv });

// 3. Create DriftClient
const driftClient = new DriftClient({
  connection,
  wallet,
  env: 'mainnet-beta',
  accountSubscription: {
    type: 'polling',
    accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
  },
});

// 4. Subscribe to updates
await driftClient.subscribe();

// 5. Check if user account exists
const user = driftClient.getUser();
const userExists = await user.exists();

if (!userExists) {
  // Initialize user account (costs ~0.035 SOL rent)
  await driftClient.initializeUserAccount();
}
```

### Basic Setup (Python)

```python
import asyncio
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from driftpy.drift_client import DriftClient
from driftpy.account_subscription_config import AccountSubscriptionConfig
from anchorpy import Wallet

async def main():
    connection = AsyncClient("https://api.mainnet-beta.solana.com")
    keypair = Keypair.from_bytes(secret_key_bytes)
    wallet = Wallet(keypair)

    drift_client = DriftClient(
        connection,
        wallet,
        "mainnet",
        account_subscription=AccountSubscriptionConfig("polling"),
    )

    await drift_client.subscribe()

    user = drift_client.get_user()
    if not await user.exists():
        await drift_client.initialize_user_account()

asyncio.run(main())
```

## Core Concepts

### 1. Precision and BN (BigNumber)

Drift uses BN.js for all numerical values due to token precision exceeding JavaScript float limits. All amounts are integers with designated precision levels.

**Key Precision Constants:**

| Constant | Value | Use Case |
|----------|-------|----------|
| `QUOTE_PRECISION` | 10^6 | USDC amounts |
| `BASE_PRECISION` | 10^9 | Perp base asset amounts |
| `PRICE_PRECISION` | 10^6 | Prices |
| `SPOT_MARKET_BALANCE_PRECISION` | 10^9 | Spot token balances |
| `FUNDING_RATE_PRECISION` | 10^9 | Funding rates |
| `MARGIN_PRECISION` | 10,000 | Margin ratios |
| `PEG_PRECISION` | 10^6 | AMM peg |
| `AMM_RESERVE_PRECISION` | 10^9 | AMM reserves |

**Conversion Helper:**
```typescript
import { convertToNumber } from '@drift-labs/sdk';

// BN division returns floor - use helper for precise division
const result = convertToNumber(new BN(10500), new BN(1000)); // = 10.5

// Converting amounts
const perpAmount = driftClient.convertToPerpPrecision(100);  // 100 base units
const spotAmount = driftClient.convertToSpotPrecision(0, 100); // 100 USDC
const price = driftClient.convertToPricePrecision(21.23);    // $21.23
```

### 2. Market Types

**Perpetual Markets** (`MarketType.PERP`):
- Derivatives with no expiry
- Positions tracked via `baseAssetAmount`
- Positive = Long, Negative = Short

**Spot Markets** (`MarketType.SPOT`):
- Real token deposits/borrows
- Positions tracked via `scaledBalance`
- `SpotBalanceType.DEPOSIT` or `SpotBalanceType.BORROW`

**Common Market Indexes:**
- `0` - USDC (quote asset)
- `1` - SOL
- Market indexes vary - query `getPerpMarketAccounts()` / `getSpotMarketAccounts()`

### 3. Order Types

```typescript
import { OrderType, PositionDirection, OrderTriggerCondition } from '@drift-labs/sdk';

// Available order types
OrderType.MARKET          // Immediate execution
OrderType.LIMIT           // Price-specific orders
OrderType.TRIGGER_MARKET  // Stop-loss/take-profit market
OrderType.TRIGGER_LIMIT   // Stop-loss/take-profit limit
OrderType.ORACLE          // Oracle-based pricing

// Position directions
PositionDirection.LONG    // Buy/bid
PositionDirection.SHORT   // Sell/ask

// Trigger conditions (for stop orders)
OrderTriggerCondition.ABOVE  // Trigger when price > threshold
OrderTriggerCondition.BELOW  // Trigger when price < threshold
```

### 4. Post-Only Parameters

```typescript
import { PostOnlyParams } from '@drift-labs/sdk';

PostOnlyParams.NONE           // No enforcement (can be taker)
PostOnlyParams.MUST_POST_ONLY // Fail if order would cross spread
PostOnlyParams.TRY_POST_ONLY  // Skip order if would cross spread
PostOnlyParams.SLIDE          // Adjust price to be post-only
```

## Trading Operations

### Placing Perpetual Orders

```typescript
// Market Order
await driftClient.placePerpOrder({
  orderType: OrderType.MARKET,
  marketIndex: 0,  // SOL-PERP
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1), // 1 SOL
});

// Limit Order
await driftClient.placePerpOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100), // $100
  postOnly: PostOnlyParams.MUST_POST_ONLY,
});

// Stop-Loss Order
await driftClient.placePerpOrder({
  orderType: OrderType.TRIGGER_MARKET,
  marketIndex: 0,
  direction: PositionDirection.SHORT, // Close long
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  triggerPrice: driftClient.convertToPricePrecision(90),
  triggerCondition: OrderTriggerCondition.BELOW,
  reduceOnly: true,
});

// Take-Profit Order
await driftClient.placePerpOrder({
  orderType: OrderType.TRIGGER_LIMIT,
  marketIndex: 0,
  direction: PositionDirection.SHORT, // Close long
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(120),
  triggerPrice: driftClient.convertToPricePrecision(120),
  triggerCondition: OrderTriggerCondition.ABOVE,
  reduceOnly: true,
});

// Oracle Order (price relative to oracle)
await driftClient.placePerpOrder({
  orderType: OrderType.ORACLE,
  marketIndex: 0,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  oraclePriceOffset: -100000, // $0.10 below oracle (PRICE_PRECISION)
  auctionDuration: 10,
  auctionStartPrice: new BN(-200000), // Start $0.20 below
  auctionEndPrice: new BN(-50000),    // End $0.05 below
});
```

### Placing Spot Orders

```typescript
// Spot Market Order
await driftClient.placeSpotOrder({
  orderType: OrderType.MARKET,
  marketIndex: 1, // SOL
  direction: PositionDirection.LONG, // Buy
  baseAssetAmount: driftClient.convertToSpotPrecision(1, 1), // 1 SOL
});

// Spot Limit Order
await driftClient.placeSpotOrder({
  orderType: OrderType.LIMIT,
  marketIndex: 1,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToSpotPrecision(1, 1),
  price: driftClient.convertToPricePrecision(100),
});
```

### Multiple Orders

```typescript
// Place multiple orders atomically
await driftClient.placeOrders([
  {
    orderType: OrderType.LIMIT,
    marketType: MarketType.PERP,
    marketIndex: 0,
    direction: PositionDirection.LONG,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(99),
  },
  {
    orderType: OrderType.LIMIT,
    marketType: MarketType.PERP,
    marketIndex: 0,
    direction: PositionDirection.SHORT,
    baseAssetAmount: driftClient.convertToPerpPrecision(1),
    price: driftClient.convertToPricePrecision(101),
  },
]);
```

### Order Management

```typescript
// Cancel by order ID
await driftClient.cancelOrder(orderId);

// Cancel by user order ID
await driftClient.cancelOrderByUserOrderId(userOrderId);

// Cancel all orders for a market
await driftClient.cancelOrders(MarketType.PERP, 0); // All SOL-PERP orders

// Cancel all orders
await driftClient.cancelOrders();

// Modify existing order
await driftClient.modifyOrder(orderId, {
  price: driftClient.convertToPricePrecision(102),
});

// Cancel and place atomically
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

### Get Orders

```typescript
// Get specific order
const order = driftClient.getOrder(orderId);

// Get order by user ID
const order = driftClient.getOrderByUserId(userOrderId);

// Get all open orders
const user = driftClient.getUser();
const openOrders = user.getOpenOrders();
```

## Deposits and Withdrawals

### Deposits

```typescript
// Get associated token account
const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(0); // USDC

// Deposit USDC
const amount = driftClient.convertToSpotPrecision(0, 100); // 100 USDC
await driftClient.deposit(amount, 0, associatedTokenAccount);

// Deposit SOL
const solAccount = await driftClient.getAssociatedTokenAccount(1);
const solAmount = driftClient.convertToSpotPrecision(1, 1); // 1 SOL
await driftClient.deposit(solAmount, 1, solAccount);

// Initialize user and deposit in one transaction
const [txSig, userPubkey] = await driftClient.initializeUserAccountAndDepositCollateral(
  driftClient.convertToSpotPrecision(0, 100),
  await driftClient.getAssociatedTokenAccount(0),
  0, // market index
  0, // sub account ID
  'MyAccount', // name
);
```

### Withdrawals

```typescript
const associatedTokenAccount = await driftClient.getAssociatedTokenAccount(0);
const amount = driftClient.convertToSpotPrecision(0, 50); // 50 USDC

// Withdraw (may create borrow if insufficient deposits)
await driftClient.withdraw(amount, 0, associatedTokenAccount);

// Withdraw with reduce-only (prevents creating borrow)
await driftClient.withdraw(amount, 0, associatedTokenAccount, undefined, true);
```

### Transfers Between Sub-Accounts

```typescript
// Transfer deposits
await driftClient.transferDeposit(
  driftClient.convertToSpotPrecision(0, 100),
  0, // market index
  0, // from sub-account
  1, // to sub-account
);

// Transfer perp positions
await driftClient.transferPerpPosition({
  fromSubAccountId: 0,
  toSubAccountId: 1,
  marketIndex: 0,
  amount: driftClient.convertToPerpPrecision(1),
});
```

## Position Management

### Reading Positions

```typescript
const user = driftClient.getUser();

// Perpetual Position
const perpPosition = user.getPerpPosition(0); // SOL-PERP
if (perpPosition) {
  const baseAmount = perpPosition.baseAssetAmount;
  const isLong = baseAmount.gt(new BN(0));
  const isShort = baseAmount.lt(new BN(0));
  console.log('Position size:', convertToNumber(baseAmount, BASE_PRECISION));
}

// All active perp positions
const activePerpPositions = user.getActivePerpPositions();

// Spot Position
const spotPosition = user.getSpotPosition(0); // USDC
const tokenAmount = user.getTokenAmount(0);
const isDeposit = tokenAmount.gt(new BN(0));
const isBorrow = tokenAmount.lt(new BN(0));

// All active spot positions
const activeSpotPositions = user.getActiveSpotPositions();
```

### Collateral and Margin

```typescript
const user = driftClient.getUser();

// Total collateral value
const totalCollateral = user.getTotalCollateral();

// Free collateral (available for new positions)
const freeCollateral = user.getFreeCollateral();

// Margin requirements
const initialMargin = user.getInitialMarginRequirement();
const maintenanceMargin = user.getMaintenanceMarginRequirement();

// Current leverage
const leverage = user.getLeverage();

// Account health (0-100, liquidation at 0)
const health = user.getHealth();

// Max leverage for a market
const maxLeverage = user.getMaxLeverageForPerp(0); // SOL-PERP

// Buying power
const buyingPower = user.getPerpBuyingPower(0);
```

### PnL Calculations

```typescript
const user = driftClient.getUser();

// Unrealized PnL (all positions)
const unrealizedPnl = user.getUnrealizedPNL();

// Unrealized PnL with funding
const unrealizedPnlWithFunding = user.getUnrealizedPNL(true);

// PnL for specific market
const marketPnl = user.getUnrealizedPNL(false, 0);

// Unrealized funding PnL
const fundingPnl = user.getUnrealizedFundingPNL();

// Settle PnL
await driftClient.settlePNL(
  user.getUserAccountPublicKey(),
  user.getUserAccount(),
  0 // market index
);
```

### Liquidation Price

```typescript
const user = driftClient.getUser();

// Get liquidation price for perp position
const liqPrice = user.liquidationPrice(0); // SOL-PERP

// Check if can be liquidated
const canBeLiquidated = user.canBeLiquidated();
```

## Market Data

### Market Accounts

```typescript
// Perpetual market
const perpMarket = driftClient.getPerpMarketAccount(0);
console.log('Market index:', perpMarket.marketIndex);
console.log('AMM base reserves:', perpMarket.amm.baseAssetReserve.toString());

// All perp markets
const allPerpMarkets = driftClient.getPerpMarketAccounts();

// Spot market
const spotMarket = driftClient.getSpotMarketAccount(0);
console.log('Decimals:', spotMarket.decimals);

// All spot markets
const allSpotMarkets = driftClient.getSpotMarketAccounts();
```

### Oracle Data

```typescript
// Get oracle price for perp market
const oracleData = driftClient.getOracleDataForPerpMarket(0);
const price = oracleData.price; // BN in PRICE_PRECISION

console.log('Oracle price:', convertToNumber(price, PRICE_PRECISION));

// Get oracle for spot market
const spotOracleData = driftClient.getOracleDataForSpotMarket(1);
```

### Calculate Prices from AMM

```typescript
import { calculateBidAskPrice } from '@drift-labs/sdk';

const perpMarket = driftClient.getPerpMarketAccount(0);
const oracleData = driftClient.getOracleDataForPerpMarket(0);

const [bidPrice, askPrice] = calculateBidAskPrice(
  perpMarket.amm,
  oracleData
);
```

## Events

### Event Subscriber

```typescript
import { EventSubscriber } from '@drift-labs/sdk';

const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
  eventTypes: [
    'DepositRecord',
    'FundingPaymentRecord',
    'LiquidationRecord',
    'OrderRecord',
    'OrderActionRecord',
    'FundingRateRecord',
    'SettlePnlRecord',
    'LPRecord',
    'InsuranceFundRecord',
    'SpotInterestRecord',
  ],
  maxTx: 4096,
  maxEventsPerType: 4096,
  commitment: 'confirmed',
  logProviderConfig: { type: 'websocket' },
});

await eventSubscriber.subscribe();

// Listen for events
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  console.log('Event type:', event.eventType);
  console.log('Event data:', event);
});

// Get events by type
const depositEvents = eventSubscriber.getEventsReceived()
  .filter(e => e.eventType === 'DepositRecord');

// Unsubscribe
await eventSubscriber.unsubscribe();
```

## Jupiter Swaps

```typescript
import { JupiterClient } from '@drift-labs/sdk';

// Initialize Jupiter client
const jupiterClient = new JupiterClient({ connection });

// Get quote preview
const quote = await jupiterClient.getQuote({
  inputMint: /* USDC mint */,
  outputMint: /* SOL mint */,
  amount: driftClient.convertToSpotPrecision(0, 100),
  slippageBps: 50,
});

// Execute swap through Drift
const txSig = await driftClient.swap({
  jupiterClient,
  inMarketIndex: 0,   // USDC
  outMarketIndex: 1,  // SOL
  amount: driftClient.convertToSpotPrecision(0, 100),
  slippageBps: 50,
  onlyDirectRoutes: false,
});
```

## Sub-Accounts

```typescript
// Create new sub-account
const [txSig, userPubkey] = await driftClient.initializeUserAccount(
  1, // sub-account ID
  'SubAccount1' // name
);

// Switch active sub-account
await driftClient.switchActiveUser(1);

// Get user for specific sub-account
const user = driftClient.getUser(1);

// Delete sub-account (must have no positions)
await driftClient.deleteUser(1);

// Update delegate (allow another key to trade)
await driftClient.updateUserDelegate(delegatePublicKey, 0);
```

## Advanced: Swift Protocol (Orderless Trades)

Swift allows off-chain order signing without Solana transactions:

```typescript
// Sign order message
const orderMessage = {
  marketIndex: 0,
  marketType: MarketType.PERP,
  direction: PositionDirection.LONG,
  baseAssetAmount: driftClient.convertToPerpPrecision(1),
  price: driftClient.convertToPricePrecision(100),
};

const signature = driftClient.signSignedMsgOrderParamsMessage(orderMessage);

// Submit to Swift server
await axios.post('https://swift.drift.trade/orders', {
  market_index: 0,
  message: signature.message,
  signature: signature.signature,
  taker_authority: wallet.publicKey.toString(),
});
```

## Advanced: Builder Codes (DBC)

For platforms routing trades through Drift to earn fees:

```typescript
// Initialize as builder
await driftClient.initializeRevenueShare(builderAuthority);

// Initialize user's escrow
await driftClient.initializeRevenueShareEscrow(userAuthority, numOrders);

// Approve builder
await driftClient.changeApprovedBuilder(
  builderAuthority,
  maxFeeTenthBps, // max fee in tenth basis points
  true // add (false to remove)
);
```

## Error Handling

```typescript
try {
  await driftClient.placePerpOrder(orderParams);
} catch (error) {
  if (error.message.includes('InsufficientCollateral')) {
    console.error('Not enough collateral for this trade');
  } else if (error.message.includes('MaxLeverageExceeded')) {
    console.error('Would exceed maximum leverage');
  } else if (error.message.includes('OrderWouldCrossMaker')) {
    console.error('Post-only order would cross spread');
  } else {
    throw error;
  }
}
```

## Resources

- [Drift Protocol Docs](https://docs.drift.trade)
- [SDK Documentation](https://drift-labs.github.io/v2-teacher/)
- [TypeScript SDK](https://github.com/drift-labs/protocol-v2/tree/master/sdk)
- [Python SDK (DriftPy)](https://github.com/drift-labs/driftpy)
- [Keeper Bots Examples](https://github.com/drift-labs/keeper-bots-v2)

## Skill Structure

```
drift-protocol/
├── SKILL.md                          # This file
├── resources/
│   ├── precision-constants.md        # All precision constants
│   ├── types-reference.md            # TypeScript types and enums
│   ├── drift-client-api.md           # DriftClient method reference
│   └── user-api.md                   # User class method reference
├── examples/
│   ├── basic-setup/                  # Client initialization
│   ├── orders/                       # Order placement examples
│   ├── deposits-withdrawals/         # Collateral management
│   ├── positions/                    # Position queries
│   ├── jupiter-swaps/                # Swap integration
│   ├── vaults/                       # Vault management
│   └── events/                       # Event subscription
├── docs/
│   ├── vaults.md                     # Vault documentation
│   ├── market-making.md              # Market making guide
│   └── troubleshooting.md            # Common issues
└── templates/
    └── trading-bot-template.ts       # Copy-paste starter
```
