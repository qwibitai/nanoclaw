# Deposits and Withdrawals Examples

## Deposits

### Deposit USDC

```typescript
import { QUOTE_PRECISION } from '@drift-labs/sdk';

// Get USDC associated token account
const usdcAta = await driftClient.getAssociatedTokenAccount(0); // 0 = USDC

// Deposit 100 USDC
const amount = driftClient.convertToSpotPrecision(0, 100);
const txSig = await driftClient.deposit(amount, 0, usdcAta);
console.log('Deposit tx:', txSig);
```

### Deposit SOL

```typescript
// Get SOL associated token account (wrapped SOL)
const solAta = await driftClient.getAssociatedTokenAccount(1); // 1 = SOL

// Deposit 1 SOL
const amount = driftClient.convertToSpotPrecision(1, 1);
const txSig = await driftClient.deposit(amount, 1, solAta);
```

### Deposit Native SOL (Auto-wrap)

```typescript
// Create wrapped SOL account and deposit in one transaction
const amount = driftClient.convertToSpotPrecision(1, 1); // 1 SOL

// Get instructions to create wrapped SOL account
const { ixs, signers, pubkey } = await driftClient.getWrappedSolAccountCreationIxs(
  amount,
  true // include rent
);

// Get deposit instruction
const depositIx = await driftClient.getDepositInstruction(
  amount,
  1, // SOL market
  pubkey,
  undefined,
  false,
  true // user initialized
);

// Build and send transaction
const tx = await driftClient.buildTransaction([...ixs, depositIx]);
await driftClient.sendTransaction(tx, signers);
```

### Initialize Account and Deposit

```typescript
// Create user account and deposit in one transaction
const [txSig, userPubkey] = await driftClient.initializeUserAccountAndDepositCollateral(
  driftClient.convertToSpotPrecision(0, 100), // 100 USDC
  await driftClient.getAssociatedTokenAccount(0),
  0, // USDC market
  0, // sub-account ID
  'TradingAccount', // name
);

console.log('User account:', userPubkey.toString());
console.log('Transaction:', txSig);
```

### Deposit to Specific Sub-Account

```typescript
const amount = driftClient.convertToSpotPrecision(0, 100);
const ata = await driftClient.getAssociatedTokenAccount(0);

// Deposit to sub-account 1
await driftClient.deposit(amount, 0, ata, 1); // subAccountId = 1
```

### Reduce-Only Deposit (Only Reduces Borrows)

```typescript
const amount = driftClient.convertToSpotPrecision(0, 100);
const ata = await driftClient.getAssociatedTokenAccount(0);

// Only deposit to reduce existing borrow, won't create deposit
await driftClient.deposit(amount, 0, ata, undefined, true); // reduceOnly = true
```

## Withdrawals

### Withdraw USDC

```typescript
const usdcAta = await driftClient.getAssociatedTokenAccount(0);
const amount = driftClient.convertToSpotPrecision(0, 50); // 50 USDC

const txSig = await driftClient.withdraw(amount, 0, usdcAta);
console.log('Withdraw tx:', txSig);
```

### Withdraw SOL

```typescript
const solAta = await driftClient.getAssociatedTokenAccount(1);
const amount = driftClient.convertToSpotPrecision(1, 0.5); // 0.5 SOL

await driftClient.withdraw(amount, 1, solAta);
```

### Reduce-Only Withdrawal (Won't Create Borrow)

```typescript
const amount = driftClient.convertToSpotPrecision(0, 100);
const ata = await driftClient.getAssociatedTokenAccount(0);

// Only withdraw existing deposits, won't create borrow
await driftClient.withdraw(amount, 0, ata, true); // reduceOnly = true
```

### Withdraw from Specific Sub-Account

```typescript
const amount = driftClient.convertToSpotPrecision(0, 50);
const ata = await driftClient.getAssociatedTokenAccount(0);

// Withdraw from sub-account 1
await driftClient.withdraw(amount, 0, ata, false, 1); // subAccountId = 1
```

## Transfers Between Sub-Accounts

### Transfer Deposits

```typescript
const amount = driftClient.convertToSpotPrecision(0, 100); // 100 USDC

// Transfer from sub-account 0 to sub-account 1
await driftClient.transferDeposit(
  amount,
  0, // USDC market
  0, // from sub-account
  1, // to sub-account
);
```

### Transfer Perp Positions

```typescript
// Transfer 1 SOL position from sub-account 0 to 1
await driftClient.transferPerpPosition({
  fromSubAccountId: 0,
  toSubAccountId: 1,
  marketIndex: 0, // SOL-PERP
  amount: driftClient.convertToPerpPrecision(1),
});
```

## Check Balances

### Get Token Amount

```typescript
const user = driftClient.getUser();

// Get USDC balance (positive = deposit, negative = borrow)
const usdcAmount = user.getTokenAmount(0);
const isDeposit = usdcAmount.gt(new BN(0));
const isBorrow = usdcAmount.lt(new BN(0));

console.log('USDC:', convertToNumber(usdcAmount, QUOTE_PRECISION));
console.log('Is deposit:', isDeposit);
console.log('Is borrow:', isBorrow);

// Get SOL balance
const solAmount = user.getTokenAmount(1);
console.log('SOL:', convertToNumber(solAmount, new BN(1e9)));
```

### Get Spot Position Details

```typescript
const user = driftClient.getUser();
const spotPosition = user.getSpotPosition(0); // USDC

if (spotPosition) {
  console.log('Market index:', spotPosition.marketIndex);
  console.log('Balance type:', spotPosition.balanceType);
  console.log('Scaled balance:', spotPosition.scaledBalance.toString());
  console.log('Open orders:', spotPosition.openOrders);
}
```

### Get All Active Positions

```typescript
const user = driftClient.getUser();

// All active spot positions
const spotPositions = user.getActiveSpotPositions();
for (const pos of spotPositions) {
  const amount = user.getTokenAmount(pos.marketIndex);
  console.log(`Market ${pos.marketIndex}: ${amount.toString()}`);
}
```

## Python Examples

```python
from driftpy.constants.numeric_constants import QUOTE_PRECISION

# Deposit USDC
usdc_ata = await drift_client.get_associated_token_account(0)
amount = drift_client.convert_to_spot_precision(100, 0)  # 100 USDC
tx_sig = await drift_client.deposit(amount, 0, usdc_ata)

# Withdraw USDC
amount = drift_client.convert_to_spot_precision(50, 0)
tx_sig = await drift_client.withdraw(amount, 0, usdc_ata)

# Transfer between sub-accounts
amount = drift_client.convert_to_spot_precision(100, 0)
await drift_client.transfer_deposit(
    amount=amount,
    market_index=0,
    from_sub_account_id=0,
    to_sub_account_id=1,
)

# Check balance
user = drift_client.get_user()
usdc_amount = user.get_token_amount(0)
print(f"USDC balance: ${usdc_amount / QUOTE_PRECISION:.2f}")
```

## Error Handling

```typescript
try {
  await driftClient.withdraw(amount, 0, ata);
} catch (error) {
  if (error.message.includes('InsufficientCollateral')) {
    console.error('Cannot withdraw: would put account below margin requirement');
  } else if (error.message.includes('InsufficientDeposits')) {
    console.error('Cannot withdraw: insufficient deposits');
  } else {
    throw error;
  }
}
```
