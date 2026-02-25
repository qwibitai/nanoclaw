# Event Subscription Examples

## Setup Event Subscriber

```typescript
import { Connection } from '@solana/web3.js';
import { EventSubscriber } from '@drift-labs/sdk';

// Create event subscriber
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
    'NewUserRecord',
    'InsuranceFundStakeRecord',
    'CurveRecord',
  ],
  maxTx: 4096,           // Max transactions to store
  maxEventsPerType: 4096, // Max events per type
  orderBy: 'blockchain',  // 'blockchain' or 'client'
  orderDir: 'desc',       // 'asc' or 'desc'
  commitment: 'confirmed',
  logProviderConfig: {
    type: 'websocket', // or 'polling'
  },
});

// Subscribe
await eventSubscriber.subscribe();
```

## Listen for Events

### All Events

```typescript
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  console.log('Event type:', event.eventType);
  console.log('Data:', event);
});
```

### Specific Event Types

```typescript
// Order fills
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  if (event.eventType === 'OrderActionRecord') {
    const orderAction = event as OrderActionRecord;

    if (orderAction.action === OrderAction.FILL) {
      console.log('Order filled!');
      console.log('Market:', orderAction.marketIndex);
      console.log('Fill amount:', orderAction.fillRecordId);
    }
  }
});

// Deposits
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  if (event.eventType === 'DepositRecord') {
    const deposit = event as DepositRecord;
    console.log('Deposit:', deposit.amount.toString());
    console.log('Market:', deposit.marketIndex);
    console.log('Direction:', deposit.direction);
  }
});

// Liquidations
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  if (event.eventType === 'LiquidationRecord') {
    const liq = event as LiquidationRecord;
    console.log('Liquidation!');
    console.log('User:', liq.user.toString());
    console.log('Liquidator:', liq.liquidator.toString());
  }
});
```

## Query Historical Events

```typescript
// Get all received events
const allEvents = eventSubscriber.getEventsReceived();

// Filter by type
const depositEvents = allEvents.filter(e => e.eventType === 'DepositRecord');
const orderEvents = allEvents.filter(e => e.eventType === 'OrderActionRecord');

// Get events by transaction
const txSignature = 'abc123...';
const txEvents = eventSubscriber.getEventsByTx(txSignature);
```

## Filter Events by Market

```typescript
// Only SOL-PERP fills
eventSubscriber.eventEmitter.on('newEvent', (event) => {
  if (
    event.eventType === 'OrderActionRecord' &&
    event.marketIndex === 0 && // SOL-PERP
    event.marketType === MarketType.PERP &&
    event.action === OrderAction.FILL
  ) {
    console.log('SOL-PERP fill:', event);
  }
});
```

## Filter Events by User

```typescript
const myUserPubkey = driftClient.getUser().getUserAccountPublicKey();

eventSubscriber.eventEmitter.on('newEvent', (event) => {
  if (
    event.eventType === 'OrderActionRecord' &&
    (event.taker?.equals(myUserPubkey) || event.maker?.equals(myUserPubkey))
  ) {
    console.log('My order filled!', event);
  }
});
```

## Event Types Reference

### OrderActionRecord

```typescript
interface OrderActionRecord {
  eventType: 'OrderActionRecord';
  ts: BN;                          // Timestamp
  action: OrderAction;             // PLACE, CANCEL, FILL, etc.
  actionExplanation: OrderActionExplanation;
  marketIndex: number;
  marketType: MarketType;
  filler?: PublicKey;
  fillerReward?: BN;
  fillRecordId?: BN;
  baseAssetAmountFilled?: BN;
  quoteAssetAmountFilled?: BN;
  takerFee?: BN;
  makerFee?: BN;
  referrerReward?: number;
  quoteAssetAmountSurplus?: BN;
  spotFulfillmentMethodFee?: BN;
  taker?: PublicKey;
  takerOrderId?: number;
  takerOrderDirection?: PositionDirection;
  takerOrderBaseAssetAmount?: BN;
  takerOrderCumulativeBaseAssetAmountFilled?: BN;
  takerOrderCumulativeQuoteAssetAmountFilled?: BN;
  maker?: PublicKey;
  makerOrderId?: number;
  makerOrderDirection?: PositionDirection;
  makerOrderBaseAssetAmount?: BN;
  makerOrderCumulativeBaseAssetAmountFilled?: BN;
  makerOrderCumulativeQuoteAssetAmountFilled?: BN;
  oraclePrice: BN;
}
```

### DepositRecord

```typescript
interface DepositRecord {
  eventType: 'DepositRecord';
  ts: BN;
  userAuthority: PublicKey;
  user: PublicKey;
  direction: DepositDirection;  // DEPOSIT or WITHDRAW
  marketIndex: number;
  amount: BN;
  oraclePrice: BN;
  marketDepositBalance: BN;
  marketWithdrawBalance: BN;
  marketCumulativeDepositInterest: BN;
  marketCumulativeBorrowInterest: BN;
  totalDepositsAfter: BN;
  totalWithdrawsAfter: BN;
  depositRecordId: BN;
}
```

### LiquidationRecord

```typescript
interface LiquidationRecord {
  eventType: 'LiquidationRecord';
  ts: BN;
  user: PublicKey;
  liquidator: PublicKey;
  liquidationType: LiquidationType;
  marginRequirement: BN;
  totalCollateral: BN;
  marginFreed: BN;
  liquidationId: number;
  bankrupt: boolean;
  canceledOrderIds: number[];
  liquidatePerp?: LiquidatePerpRecord;
  liquidateSpot?: LiquidateSpotRecord;
  liquidateBorrowForPerpPnl?: LiquidateBorrowForPerpPnlRecord;
  perpBankruptcy?: PerpBankruptcyRecord;
  spotBankruptcy?: SpotBankruptcyRecord;
}
```

### FundingPaymentRecord

```typescript
interface FundingPaymentRecord {
  eventType: 'FundingPaymentRecord';
  ts: BN;
  user: PublicKey;
  marketIndex: number;
  fundingPayment: BN;
  baseAssetAmount: BN;
  userLastCumulativeFunding: BN;
  ammCumulativeFundingLong: BN;
  ammCumulativeFundingShort: BN;
}
```

## Polling Configuration

```typescript
// Use polling instead of websocket
const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
  eventTypes: ['OrderActionRecord'],
  logProviderConfig: {
    type: 'polling',
    frequency: 1000, // Poll every 1 second
  },
});
```

## Cleanup

```typescript
// Always unsubscribe when done
await eventSubscriber.unsubscribe();
```

## Python Examples

```python
from driftpy.events.event_subscriber import EventSubscriber

# Create event subscriber
event_subscriber = EventSubscriber(
    connection,
    drift_client.program,
    commitment="confirmed",
)

# Subscribe
await event_subscriber.subscribe()

# Listen for events
def on_event(event):
    print(f"Event: {event}")

event_subscriber.event_emitter.new_event += on_event

# Get events
events = event_subscriber.get_events_received()

# Unsubscribe
await event_subscriber.unsubscribe()
```
