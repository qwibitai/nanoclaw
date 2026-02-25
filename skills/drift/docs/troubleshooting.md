# Troubleshooting Guide

## Common Errors

### InsufficientCollateral

**Error**: `InsufficientCollateral`

**Cause**: Not enough free collateral for the trade.

**Solutions**:
```typescript
// Check free collateral before trading
const user = driftClient.getUser();
const freeCollateral = user.getFreeCollateral();
console.log('Free collateral:', convertToNumber(freeCollateral, QUOTE_PRECISION));

// Check margin required for trade
const marginRequired = user.getMarginUSDCRequiredForTrade(
  marketIndex,
  driftClient.convertToPerpPrecision(size),
  driftClient.convertToPricePrecision(price)
);

if (freeCollateral.lt(marginRequired)) {
  console.log('Need more collateral');
}
```

### OrderWouldCrossMaker / CrossedMaker

**Error**: `OrderWouldCrossMaker`

**Cause**: Post-only order would execute as taker.

**Solutions**:
```typescript
// Option 1: Adjust price
const perpMarket = driftClient.getPerpMarketAccount(marketIndex);
const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
const [bidPrice, askPrice] = calculateBidAskPrice(perpMarket.amm, oracleData);

// For buy: price below current ask
const safePrice = convertToNumber(askPrice, PRICE_PRECISION) * 0.99;

// Option 2: Use TRY_POST_ONLY (silently fails)
postOnly: PostOnlyParams.TRY_POST_ONLY,

// Option 3: Use SLIDE (auto-adjusts price)
postOnly: PostOnlyParams.SLIDE,
```

### MaxLeverageExceeded

**Error**: `MaxLeverageExceeded`

**Cause**: Trade would exceed maximum leverage.

**Solutions**:
```typescript
// Check max leverage
const user = driftClient.getUser();
const maxLeverage = user.getMaxLeverageForPerp(marketIndex);
const currentLeverage = user.getLeverage();

// Reduce position size or add collateral
```

### UserAccountNotFound

**Error**: `UserAccountNotFound` or account not initialized

**Cause**: User account doesn't exist yet.

**Solutions**:
```typescript
const user = driftClient.getUser();
const exists = await user.exists();

if (!exists) {
  await driftClient.initializeUserAccount();
  // Or with collateral:
  await driftClient.initializeUserAccountAndDepositCollateral(
    amount,
    tokenAccount,
    marketIndex
  );
}
```

### AccountNotSubscribed

**Error**: Account data not available

**Cause**: Not subscribed to DriftClient.

**Solutions**:
```typescript
// Make sure to subscribe
await driftClient.subscribe();

// Or force fetch
await driftClient.fetchAccounts();
```

### InvalidOraclePrice / OracleStale

**Error**: Oracle price issues

**Cause**: Oracle data is stale or invalid.

**Solutions**:
```typescript
// Check oracle validity
const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);

if (!oracleData || oracleData.price.eq(new BN(0))) {
  console.log('Oracle data unavailable');
  // Wait and retry
}

// Force refresh
await driftClient.fetchAccounts();
```

### TransactionTooLarge

**Error**: Transaction exceeds size limit

**Cause**: Too many accounts or instructions in one transaction.

**Solutions**:
```typescript
// Split into multiple transactions
const orders = [...]; // Many orders

// Instead of one large tx:
// await driftClient.placeOrders(orders);

// Split into batches:
const batchSize = 3;
for (let i = 0; i < orders.length; i += batchSize) {
  const batch = orders.slice(i, i + batchSize);
  await driftClient.placeOrders(batch);
}
```

### SlippageTolerance / PriceBandExceeded

**Error**: Price slippage too high

**Cause**: Price moved beyond tolerance during execution.

**Solutions**:
```typescript
// For swaps, increase slippage
await driftClient.swap({
  jupiterClient,
  inMarketIndex: 0,
  outMarketIndex: 1,
  amount,
  slippageBps: 100, // 1% instead of 0.5%
});

// For orders, use wider price bands
// Or use ORACLE order type for dynamic pricing
```

## Connection Issues

### RPC Timeouts

```typescript
// Use reliable RPC
const connection = new Connection('https://your-rpc.com', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

// Or increase timeout
const txParams = {
  timeout: 60000, // 60 seconds
};
```

### WebSocket Disconnections

```typescript
// Handle reconnection
driftClient.eventEmitter.on('error', async (error) => {
  console.error('Connection error:', error);

  // Attempt reconnection
  await driftClient.unsubscribe();
  await driftClient.subscribe();
});
```

## Debugging Tips

### Enable Logging

```typescript
// Log all transactions
const txSig = await driftClient.placePerpOrder(params);
console.log('Transaction:', `https://solscan.io/tx/${txSig}`);
```

### Check Transaction Logs

```typescript
// Get transaction details
const tx = await connection.getTransaction(txSig, {
  maxSupportedTransactionVersion: 0,
});

console.log('Logs:', tx?.meta?.logMessages);
```

### Verify Account State

```typescript
// Force refresh all accounts
await driftClient.fetchAccounts();

// Check specific account
const userAccount = await driftClient.forceGetUserAccount();
console.log('User account:', userAccount);

// Verify market state
const perpMarket = await driftClient.forceGetPerpMarketAccount(marketIndex);
console.log('Market status:', perpMarket.status);
```

## Devnet Testing

### Get Test Tokens

```bash
# SOL airdrop
solana airdrop 2 --url devnet

# Use Drift faucet for USDC
# https://app.drift.trade (devnet mode)
```

### Devnet Configuration

```typescript
const driftClient = new DriftClient({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet,
  env: 'devnet',
});
```

## Performance Optimization

### Batch Operations

```typescript
// Batch multiple orders
await driftClient.placeOrders([order1, order2, order3]);

// Batch cancel and place
await driftClient.cancelAndPlaceOrders({
  cancelOrderParams: { marketType, marketIndex },
  placeOrderParams: [newOrder1, newOrder2],
});
```

### Use Lookup Tables

```typescript
// Fetch lookup tables for smaller transactions
const lookupTables = await driftClient.fetchAllLookupTableAccounts();
```

### Polling vs WebSocket

```typescript
// Polling (more stable, higher latency)
accountSubscription: {
  type: 'polling',
  accountLoader: new BulkAccountLoader(connection, 'confirmed', 1000),
}

// WebSocket (lower latency, may disconnect)
accountSubscription: {
  type: 'websocket',
  resubTimeoutMs: 30000,
  commitment: 'confirmed',
}
```

## Getting Help

- [Drift Discord](https://discord.gg/drift) - #dev-chat
- [GitHub Issues](https://github.com/drift-labs/protocol-v2/issues)
- [Documentation](https://docs.drift.trade)
