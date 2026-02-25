# DriftClient API Reference

Complete reference for all DriftClient methods.

## Constructor & Initialization

### DriftClient Constructor

```typescript
const driftClient = new DriftClient({
  connection: Connection,           // Solana connection
  wallet: IWallet,                  // Wallet interface
  env: DriftEnv,                    // 'mainnet-beta' | 'devnet'
  programID?: PublicKey,            // Optional custom program ID
  accountSubscription?: {
    type: 'polling' | 'websocket',
    accountLoader?: BulkAccountLoader,
    resubTimeoutMs?: number,
    commitment?: Commitment,
  },
  perpMarketIndexes?: number[],     // Markets to subscribe to
  spotMarketIndexes?: number[],
  oracleInfos?: OracleInfo[],
  userStats?: boolean,
  includeDelegates?: boolean,
  subAccountIds?: number[],
  activeSubAccountId?: number,
  authority?: PublicKey,
  txParams?: TxParams,
  txVersion?: TransactionVersion,
  txSender?: TxSender,
});
```

### Subscription Methods

| Method | Description |
|--------|-------------|
| `subscribe(): Promise<boolean>` | Subscribe to all accounts |
| `subscribeUsers(): Promise<boolean>[]` | Subscribe to user accounts |
| `fetchAccounts(): Promise<void>` | Force fetch from RPC |
| `unsubscribe(): Promise<void>` | Unsubscribe from all |
| `unsubscribeUsers(): Promise<void>[]` | Unsubscribe from users |

## User Account Management

### Account Initialization

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `initializeUserAccount` | `subAccountId?, name?, referrerInfo?, txParams?` | `Promise<[TxSig, PublicKey]>` | Create user account |
| `initializeUserAccountAndDepositCollateral` | `amount, userTokenAccount, marketIndex?, subAccountId?, name?, fromSubAccountId?, referrerInfo?, donateAmount?, txParams?, customMaxMarginRatio?, poolId?` | `Promise<[TxSig, PublicKey]>` | Create and fund account |
| `deleteUser` | `subAccountId?, txParams?` | `Promise<TxSig>` | Delete user account |
| `reclaimRent` | `subAccountId?, txParams?` | `Promise<TxSig>` | Reclaim rent from deleted |

### Account Queries

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getUser` | `subAccountId?, authority?` | `User` | Get User instance |
| `hasUser` | `subAccountId?, authority?` | `boolean` | Check if user exists |
| `getUsers` | - | `User[]` | Get all users |
| `getUserAccount` | `subAccountId?, authority?` | `UserAccount \| undefined` | Get account data |
| `forceGetUserAccount` | `subAccountId?, authority?` | `Promise<UserAccount>` | Fetch from RPC |
| `getUserAccountPublicKey` | `subAccountId?, authority?` | `Promise<PublicKey>` | Get account pubkey |

### Account Updates

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `updateUserName` | `name, subAccountId?` | `Promise<TxSig>` | Update account name |
| `updateUserDelegate` | `delegate, subAccountId?` | `Promise<TxSig>` | Set delegate |
| `updateUserCustomMarginRatio` | `updates[]` | `Promise<TxSig>` | Update margin ratio |
| `updateUserMarginTradingEnabled` | `updates[]` | `Promise<TxSig>` | Enable margin trading |
| `switchActiveUser` | `subAccountId, authority?` | `Promise<void>` | Switch active account |

## Deposit & Withdrawal

### Deposit Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `deposit` | `amount, marketIndex, associatedTokenAccount, subAccountId?, reduceOnly?, txParams?` | `Promise<TxSig>` | Deposit tokens |
| `createDepositTxn` | Same as deposit | `Promise<Transaction>` | Create deposit transaction |
| `getDepositInstruction` | `amount, marketIndex, userTokenAccount, subAccountId?, reduceOnly?, userInitialized?` | `Promise<TxInstruction>` | Get deposit instruction |

### Withdrawal Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `withdraw` | `amount, marketIndex, associatedTokenAccount, reduceOnly?, subAccountId?, txParams?` | `Promise<TxSig>` | Withdraw tokens |
| `createWithdrawTxn` | Same as withdraw | `Promise<Transaction>` | Create withdraw transaction |
| `getWithdrawInstruction` | `amount, marketIndex, userTokenAccount, reduceOnly?, subAccountId?` | `Promise<TxInstruction>` | Get withdraw instruction |

### Transfer Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `transferDeposit` | `amount, marketIndex, fromSubAccountId, toSubAccountId, txParams?` | `Promise<TxSig>` | Transfer deposits |
| `transferPerpPosition` | `{fromSubAccountId, toSubAccountId, marketIndex, amount}` | `Promise<TxSig>` | Transfer perp position |

## Order Management

### Place Orders

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `placePerpOrder` | `orderParams, txParams?, subAccountId?` | `Promise<TxSig>` | Place perp order |
| `placeSpotOrder` | `orderParams, txParams?, subAccountId?` | `Promise<TxSig>` | Place spot order |
| `placeOrders` | `orderParams[], txParams?` | `Promise<TxSig>` | Place multiple orders |
| `placeAndTakePerpOrder` | `orderParams, makerInfo?, referrerInfo?, txParams?` | `Promise<TxSig>` | Atomic place and fill |

### Cancel Orders

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `cancelOrder` | `orderId, txParams?` | `Promise<TxSig>` | Cancel by order ID |
| `cancelOrderByUserOrderId` | `userOrderId, txParams?` | `Promise<TxSig>` | Cancel by user ID |
| `cancelOrders` | `marketType?, marketIndex?, direction?` | `Promise<TxSig>` | Cancel filtered orders |
| `cancelAllOrders` | `marketType?, marketIndex?, direction?` | `Promise<TxSig>` | Cancel all orders |

### Modify Orders

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `modifyOrder` | `orderId, modifyParams, txParams?` | `Promise<TxSig>` | Modify existing order |
| `modifyOrderByUserOrderId` | `userOrderId, modifyParams, txParams?` | `Promise<TxSig>` | Modify by user ID |
| `cancelAndPlaceOrders` | `{cancelOrderParams, placeOrderParams}, txParams?` | `Promise<TxSig>` | Atomic cancel and place |

### Order Queries

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getOrder` | `orderId, subAccountId?` | `Order \| undefined` | Get order by ID |
| `getOrderByUserId` | `userOrderId, subAccountId?` | `Order \| undefined` | Get by user ID |

## Market Data

### Perpetual Markets

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getPerpMarketAccount` | `marketIndex` | `PerpMarketAccount \| undefined` | Get perp market |
| `forceGetPerpMarketAccount` | `marketIndex` | `Promise<PerpMarketAccount>` | Fetch from RPC |
| `getPerpMarketAccounts` | - | `PerpMarketAccount[]` | Get all perp markets |

### Spot Markets

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getSpotMarketAccount` | `marketIndex` | `SpotMarketAccount \| undefined` | Get spot market |
| `forceGetSpotMarketAccount` | `marketIndex` | `Promise<SpotMarketAccount>` | Fetch from RPC |
| `getSpotMarketAccounts` | - | `SpotMarketAccount[]` | Get all spot markets |
| `getQuoteSpotMarketAccount` | - | `SpotMarketAccount` | Get USDC market |

### Oracle Data

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getOracleDataForPerpMarket` | `marketIndex` | `OraclePriceData` | Get perp oracle price |
| `getOracleDataForSpotMarket` | `marketIndex` | `OraclePriceData` | Get spot oracle price |
| `getOraclePriceDataAndSlot` | `oraclePublicKey, oracleSource` | `DataAndSlot<OraclePriceData>` | Get oracle with slot |

## Position Queries

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getSpotPosition` | `marketIndex, subAccountId?` | `SpotPosition \| undefined` | Get spot position |
| `getTokenAmount` | `marketIndex` | `BN` | Get signed token amount |
| `getQuoteAssetTokenAmount` | - | `BN` | Get USDC balance |

## PnL & Settlement

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `settlePNL` | `userAccountKey, userAccount, marketIndex` | `Promise<TxSig>` | Settle perp PnL |
| `settleMultiplePNLs` | `settlePnlParams[]` | `Promise<TxSig>` | Batch settle PnL |

## Jupiter Integration

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `swap` | `{jupiterClient, inMarketIndex, outMarketIndex, amount, slippageBps?, onlyDirectRoutes?}` | `Promise<TxSig>` | Execute Jupiter swap |
| `getJupiterSwapIx` | Same params | `Promise<TxInstruction[]>` | Get swap instructions |

## Conversion Helpers

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `convertToSpotPrecision` | `marketIndex, amount` | `BN` | Convert to spot precision |
| `convertToPerpPrecision` | `amount` | `BN` | Convert to perp precision |
| `convertToPricePrecision` | `amount` | `BN` | Convert to price precision |

## Token Accounts

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getAssociatedTokenAccount` | `marketIndex, useNative?, tokenProgram?, authority?` | `Promise<PublicKey>` | Get ATA address |
| `getWrappedSolAccountCreationIxs` | `amount, includeRent?` | `Promise<{ixs, signers, pubkey}>` | Create wrapped SOL |

## State & Configuration

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `getStateAccount` | - | `StateAccount` | Get protocol state |
| `forceGetStateAccount` | - | `Promise<StateAccount>` | Fetch from RPC |
| `getStatePublicKey` | - | `Promise<PublicKey>` | Get state pubkey |
| `getSignerPublicKey` | - | `PublicKey` | Get signer pubkey |

## Wallet Management

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `updateWallet` | `newWallet, subAccountIds?, activeSubAccountId?, includeDelegates?` | `Promise<boolean>` | Update wallet |
| `emulateAccount` | `emulateAuthority` | `Promise<boolean>` | Emulate another user |

## Revenue Share (Builder Codes)

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `initializeRevenueShare` | `authority, txParams?` | `Promise<TxSig>` | Init revenue share |
| `initializeRevenueShareEscrow` | `authority, numOrders, txParams?` | `Promise<TxSig>` | Init escrow |
| `changeApprovedBuilder` | `builder, maxFeeTenthBps, add, txParams?` | `Promise<TxSig>` | Add/remove builder |

## Swift Protocol (Orderless)

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `signSignedMsgOrderParamsMessage` | `orderMessage` | `{message, signature}` | Sign order off-chain |
| `initializeSignedMsgUserOrders` | `authority, numOrders, txParams?` | `Promise<[TxSig, PublicKey]>` | Init Swift account |
| `deleteSignedMsgUserOrders` | `txParams?` | `Promise<TxSig>` | Delete Swift account |

## Transaction Building

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| `buildTransaction` | `ixs, txParams?` | `Promise<Transaction>` | Build transaction |
| `sendTransaction` | `tx, signers?, opts?` | `Promise<TxSigAndSlot>` | Send transaction |

## Instruction Getters

All order/account methods have corresponding `get*Ix` or `get*Instruction` variants that return `TransactionInstruction` instead of sending the transaction. Use these for custom transaction building.

Example:
```typescript
// Instead of:
await driftClient.placePerpOrder(params);

// Use for custom tx:
const ix = await driftClient.getPlacePerpOrderIx(params);
const tx = new Transaction().add(ix);
// Add more instructions, custom logic, etc.
await driftClient.sendTransaction(tx);
```
