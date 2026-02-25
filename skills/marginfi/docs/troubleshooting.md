# Marginfi Troubleshooting Guide

Common issues, errors, and solutions when working with Marginfi.

## Account & Initialization

### "No accounts found" when querying user accounts

**Problem**: `MarginfiAccount.findAllByOwner()` returns empty array even after creating an account.

**Solutions**:
1. Ensure you're querying with the correct wallet public key
2. Wait a few seconds after creation for indexing
3. Verify account was created successfully by checking the transaction signature
4. Try refreshing the account data: `account.reload()`

```typescript
// Verify account exists
const userAccounts = await MarginfiAccount.findAllByOwner(connection, wallet.publicKey);
if (userAccounts.length > 0) {
  console.log("Found", userAccounts.length, "accounts");
}
```

### Bank not found for deposit/borrow

**Problem**: `BankNotFound` error when trying to deposit or borrow.

**Solutions**:
1. Verify the bank label is correct (case-sensitive)
2. List all available banks:
   ```typescript
   client.banks.forEach(bank => console.log(bank.label));
   ```
3. Ensure you're using the correct group

```typescript
// Safely get bank
const bank = client.getBankByTokenSymbol("SOL");
if (!bank) {
  console.log("Available banks:");
  client.banks.forEach(b => console.log(`  - ${b.label}`));
}
```

## Health & Risk

### Invalid Health

**Problem**: Transaction fails because account health is insufficient.

**Solutions**:
1. Deposit more collateral first
2. Check health components and free collateral:
  ```typescript
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = assets.minus(liabilities);
  const freeCollateral = account.computeFreeCollateral();
  console.log("Net health:", netHealth.toString());
  console.log("Free collateral:", freeCollateral.toString());
  ```
3. Repay existing loans to improve health
4. Use different collateral with better LTV
5. Check oracle confidence - high confidence intervals reduce effective collateral value

```typescript
async function safeBorrow(amount: Decimal) {
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = assets.minus(liabilities);
  const maxBorrow = account.computeMaxBorrowForBank(bank.address);

  if (netHealth.lte(0) || maxBorrow.lt(amount)) {
    const needed = amount.minus(maxBorrow);
    console.log("Need to reduce borrow or add collateral by", needed.toString());
    return;
  }

  await borrow(client, account, "SOL", amount);
}
```

### Account liquidated unexpectedly

**Problem**: Account was liquidated even though health seemed positive.

**Likely causes**:
1. **Price oracle updated** - Assets dropped in value more than expected
2. **Interest accrual** - Borrowing APY increased your debt
3. **Oracle confidence** - Negative price swings use confidence intervals

**Prevention**:
1. Monitor health continuously
2. Leave sufficient health buffer
3. Set up liquidation alerts

```typescript
// Conservative health check
const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
const netHealth = assets.minus(liabilities);
const freeCollateral = account.computeFreeCollateral();
const safetyFactor = 1.5; // 50% buffer

if (netHealth.lt(freeCollateral.dividedBy(safetyFactor))) {
  console.warn("Health too low, consider reducing position");
}
```

## Transactions & Signing

### "Insufficient funds for transaction"

**Problem**: Transaction fails during execution.

**Solutions**:
1. Ensure wallet has SOL for rent/fees (0.1+ SOL recommended)
2. Check account balance:
   ```typescript
   const balance = await connection.getBalance(wallet.publicKey);
   console.log("SOL balance:", balance / 1e9);
   ```
3. Increase compute budget if transaction is complex
4. Break large operations into multiple transactions
5. Use blockhash with recent slot

```typescript
async function sendWithRetry(txn: Transaction) {
  let maxRetries = 3;
  while (maxRetries > 0) {
    try {
      const signature = await connection.sendTransaction(txn, [wallet]);
      await connection.confirmTransaction(signature);
      return signature;
    } catch (error) {
      maxRetries--;
      if (maxRetries === 0) throw error;
      await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
    }
  }
}
```

## Oracle & Price Issues

### "Oracle price stale" error

**Problem**: Transaction fails because oracle data is outdated.

**Causes**:
1. Switchboard oracle hasn't been cranked recently
2. Price feed is down or not updating
3. Too much time passed since last oracle update

**Solutions**:
1. Manually crank Switchboard oracle before transaction
2. Wait for oracle update
3. Check last update:
   ```typescript
  const bank = client.getBankByTokenSymbol("SOL");
   console.log("Last oracle update:", bank.lastOracleUpdate);
   ```

### Prices seem incorrect

**Problem**: On-chain prices don't match market prices.

**Likely causes**:
1. **Confidence interval adjustment** - Oracle prices use confidence bounds
2. **EMA vs Spot** - Different prices for assets vs liabilities
3. **Oracle lag** - Slight delay in price updates
4. **Fixed prices** - Some banks use manually set prices

**Understanding prices**:
```typescript
// When pricing assets (collateral)
const assetPrice = oraclePrice - confidence;

// When pricing liabilities (debt)
const liabilityPrice = oraclePrice + confidence;

// Example: SOL at $100 ±$2
// Assets valued at: $98
// Liabilities valued at: $102
```

## Interest & Accounting

### Interest seems lower than expected APY

**Problem**: Actual yield doesn't match advertised APY.

**Possible causes**:
1. **Interest compounds by transaction, not time** - Less frequent = lower APY
2. **APY vs APR confusion** - SDK shows APR (simple), APY is compounded
3. **Recent deposits** - Interest only accrues since last balance change
4. **Utilization changes** - Rates fluctuate with borrow/deposit ratios

**Example calculation**:
```
Advertised APR: 5%
Compounding frequency: Varies by bank activity
- Active bank: compounds every few minutes = ~5.12% APY
- Inactive bank: compounds daily = ~5.03% APY
```

### Repay amount changed after submission

**Problem**: Amount needed to repay is different than calculated.

**Cause**: Interest accrued between calculation and transaction submission.

**Solution**: Use the `repayAll` boolean parameter when repaying to repay all debt and automatically handle interest:
```typescript
// Repay all debt and close the liability position
await repay(0, accountAddress, true);
```

## RPC & Network

### "RPC request failed" errors

**Problem**: Random network errors during transactions.

**Solutions**:
1. Try different RPC endpoint:
   ```typescript
   const rpcs = [
     "https://api.mainnet-beta.solana.com",
     "https://rpc.ankr.com/solana",
     "https://api.helius.xyz/v0/access-token/<token>/solana-mainnet"
   ];
   ```
2. Add retry logic with exponential backoff
3. Increase timeout values
4. Check RPC rate limits

```typescript
async function callWithBackoff(fn: Function, maxRetries: number = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * 1000; // Exponential backoff
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

### Connection drops / data inconsistency

**Problem**: Account data becomes stale or disconnects.

**Solution**:
```typescript
// Reload account data frequently
const account = await MarginfiAccount.fetch(accountPubkey, connection);

// Or use auto-refresh
const refreshInterval = setInterval(async () => {
  await account.reload();
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  console.log("Net health:", assets.minus(liabilities).toString());
}, 10000);
```

## SDK Updates & Breaking Changes

### "Unknown program" or type errors after update

**Problem**: SDK version mismatch or program address changed.

**Solutions**:
1. Check version compatibility
2. Update all SDK packages together:
   ```bash
   npm update @mrgnlabs/marginfi-client-v2 @mrgnlabs/mrgn-common
   ```
3. Verify group/program addresses match deployment
4. Check release notes for breaking changes

### Deprecated methods

**Problem**: Using methods that were removed.

**Check official examples**:
```bash
# See current working examples
https://github.com/mrgnlabs/mrgn-ts/tree/main/packages/marginfi-client-v2/examples
```

## Getting Help

If you encounter issues not covered here:

1. **Check error logs** - Enable debug logging:
   ```typescript
   import { setLogLevel } from "@mrgnlabs/marginfi-client-v2";
   setLogLevel("debug");
   ```

2. **Search GitHub Issues** - https://github.com/mrgnlabs/marginfi-v2/issues

3. **Contact support** - Marginfi Discord/Telegram for integrator help

4. **Submit minimal reproduction** - Include:
   - Exact error message
   - Code snippet that reproduces issue
   - Environment details (network, SDK version, etc.)
