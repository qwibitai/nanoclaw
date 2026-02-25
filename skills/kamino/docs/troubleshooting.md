# Kamino Troubleshooting Guide

Common issues and solutions when working with Kamino SDKs.

## Lending SDK Issues

### Transaction Fails with "Insufficient Funds"

**Problem**: Deposit or borrow transaction fails with insufficient funds error.

**Solutions**:
1. Check token balance before operation:
```typescript
const balance = await connection.getBalance(wallet.publicKey);
const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
```

2. Ensure you have enough SOL for transaction fees (~0.01 SOL minimum)

3. For deposits, verify the token amount is within your wallet balance

### "Obligation Not Found" Error

**Problem**: Operations fail because no obligation exists.

**Solutions**:
1. Make a deposit first to create the obligation:
```typescript
// First deposit creates the obligation
await KaminoAction.buildDepositTxns(market, amount, symbol, wallet, obligation);
```

2. Verify you're using the correct obligation type:
```typescript
// For standard operations, use VanillaObligation
const obligation = new VanillaObligation(PROGRAM_ID);
```

### "Reserve Not Found" Error

**Problem**: Cannot find the specified reserve.

**Solutions**:
1. Ensure reserves are loaded:
```typescript
const market = await KaminoMarket.load(connection, marketAddress);
await market.loadReserves(); // Don't forget this!
```

2. Check the token symbol is correct (case-sensitive):
```typescript
// Correct
market.getReserve("SOL");
market.getReserve("USDC");

// Wrong
market.getReserve("sol");
market.getReserve("usdc");
```

3. Use mint address if symbol doesn't work:
```typescript
const reserve = market.getReserve(new PublicKey("token_mint_address"));
```

### "Borrow Limit Exceeded" Error

**Problem**: Cannot borrow more due to collateral limits.

**Solutions**:
1. Check current borrow capacity:
```typescript
const obligation = await market.getUserVanillaObligation(wallet);
const stats = obligation.refreshedStats;
const available = stats.borrowLimit.sub(stats.borrowedValue);
console.log("Available to borrow:", available.toString());
```

2. Deposit more collateral or repay existing debt

3. Choose assets with higher LTV ratios

### "Health Factor Too Low" Error

**Problem**: Operation would make position unhealthy.

**Solutions**:
1. Calculate health factor before operation:
```typescript
const healthFactor = borrowLimit.div(borrowedValue);
if (healthFactor.lt(1.1)) {
  console.log("Position too risky");
}
```

2. Repay debt or add collateral first

### Transaction Size Exceeded

**Problem**: Transaction too large for Solana limits.

**Solutions**:
1. Use address lookup tables:
```typescript
const { instructions, lookupTables } = await kaminoAction.buildWithLookupTables();
const messageV0 = new TransactionMessage({
  payerKey: wallet.publicKey,
  recentBlockhash: blockhash,
  instructions,
}).compileToV0Message(lookupTables);
```

2. Split operations into multiple transactions

3. Reduce compute budget if not needed:
```typescript
// Only add compute budget if operations are complex
const action = await KaminoAction.buildDepositTxns(
  market,
  amount,
  symbol,
  wallet,
  obligation,
  0 // No extra compute budget
);
```

## Liquidity SDK Issues

### "Strategy Not Found" Error

**Problem**: Cannot find strategy by address.

**Solutions**:
1. Verify strategy address is correct
2. Check if strategy is on the correct cluster (mainnet vs devnet)
3. Try fetching all strategies first:
```typescript
const strategies = await kamino.getStrategiesWithAddresses();
const found = strategies.find(s => s.address.equals(targetAddress));
```

### Slippage Error on Deposit/Withdraw

**Problem**: Transaction fails due to price slippage.

**Solutions**:
1. Increase slippage tolerance:
```typescript
const slippage = new Decimal(0.02); // 2% instead of default 0.5%
await kamino.deposit(strategy, wallet, amountA, amountB, slippage);
```

2. For volatile pairs, use higher slippage:
```typescript
// For single-sided deposits or volatile pairs
const slippage = new Decimal(0.05); // 5%
```

3. Check current price and adjust amounts:
```typescript
const range = await kamino.getStrategyRange(strategy);
console.log("Current price:", range.currentPrice);
```

### "Position Out of Range" Warning

**Problem**: Strategy position is outside the active price range.

**Solutions**:
1. Check if position is in range:
```typescript
const range = await kamino.getStrategyRange(strategy);
if (!range.isInRange) {
  console.log("Position out of range - not earning fees");
}
```

2. Wait for automatic rebalance (if strategy supports it)
3. Consider withdrawing and depositing to a different strategy

### Share Balance is Zero

**Problem**: `getTokenAccountBalance` returns 0 even after deposit.

**Solutions**:
1. Check the correct kToken mint:
```typescript
const strategy = await kamino.getStrategyByAddress(address);
const kTokenMint = strategy.sharesMint;
const ata = await getAssociatedTokenAddress(kTokenMint, wallet);
```

2. Wait for transaction confirmation:
```typescript
await sendAndConfirmTransaction(connection, tx, [wallet], {
  commitment: "confirmed"
});
// Then check balance
```

### Compute Budget Exceeded

**Problem**: Transaction fails due to compute limits.

**Solutions**:
1. Increase compute budget:
```typescript
const tx = kamino.createTransactionWithExtraBudget(600000); // Higher budget
```

2. For single-token deposits (which involve swaps):
```typescript
const tx = kamino.createTransactionWithExtraBudget(800000);
```

## Scope Oracle Issues

### "Token Not Found" Error

**Problem**: Requested token not in Scope mapping.

**Solutions**:
1. Check supported tokens:
```typescript
const mapping = await scope.getOracleMapping();
console.log("Supported tokens:", [...mapping.tokens.keys()]);
```

2. Use mint address instead of symbol:
```typescript
const price = await scope.getPriceByMint(tokenMint);
```

### Stale Price Warning

**Problem**: Price data is too old.

**Solutions**:
1. Check price age:
```typescript
const priceWithMeta = await scope.getPriceWithMetadata("SOL");
if (priceWithMeta.ageSlots > 100) {
  console.log("Price may be stale");
}
```

2. Refresh prices:
```typescript
await scope.refreshPrices();
const freshPrice = await scope.getPrice("SOL");
```

3. Use TWAP for more stable prices:
```typescript
const twapPrice = await scope.getTwapPrice("SOL");
```

## General Issues

### RPC Rate Limiting

**Problem**: Too many requests to RPC endpoint.

**Solutions**:
1. Use a dedicated RPC (Helius, QuickNode, etc.)
2. Implement request batching:
```typescript
// Bad: Multiple separate calls
for (const reserve of reserves) {
  await market.getReserve(reserve);
}

// Good: Load all at once
await market.loadReserves();
```

3. Add delays between operations:
```typescript
await new Promise(resolve => setTimeout(resolve, 1000));
```

### Wallet Keypair Issues

**Problem**: Cannot load wallet or sign transactions.

**Solutions**:
1. Verify keypair file format (should be JSON array):
```json
[1,2,3,4,5,...] // 64 bytes
```

2. Load correctly:
```typescript
const secretKey = new Uint8Array(JSON.parse(fs.readFileSync("keypair.json")));
const wallet = Keypair.fromSecretKey(secretKey);
```

3. Check file permissions

### Transaction Timeout

**Problem**: Transaction not confirmed in time.

**Solutions**:
1. Increase confirmation timeout:
```typescript
await sendAndConfirmTransaction(connection, tx, [wallet], {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
```

2. Add retry logic:
```typescript
async function sendWithRetry(tx, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await sendAndConfirmTransaction(connection, tx, [wallet]);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
```

3. Check network status

### Blockhash Expired

**Problem**: Transaction fails with expired blockhash.

**Solutions**:
1. Get fresh blockhash right before sending:
```typescript
const { blockhash } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;
```

2. For Kamino SDK:
```typescript
await kamino.assignBlockInfoToTransaction(tx);
// Send immediately after
```

## Debugging Tips

### Enable Verbose Logging

```typescript
// Add to your code
console.log("Market address:", market.address.toString());
console.log("Reserve count:", market.reserves.size);
console.log("Obligation:", obligation?.address.toString());

// Log transaction details
const instructions = [...action.setupIxs, ...action.lendingIxs];
console.log("Instruction count:", instructions.length);
for (const ix of instructions) {
  console.log("Program:", ix.programId.toString());
}
```

### Simulate Before Sending

```typescript
const simulation = await connection.simulateTransaction(tx);
if (simulation.value.err) {
  console.error("Simulation failed:", simulation.value.err);
  console.log("Logs:", simulation.value.logs);
}
```

### Check Account State

```typescript
// Check if accounts exist
const accountInfo = await connection.getAccountInfo(address);
if (!accountInfo) {
  console.log("Account does not exist");
} else {
  console.log("Owner:", accountInfo.owner.toString());
  console.log("Data length:", accountInfo.data.length);
}
```

## Getting Help

1. **Kamino Discord**: Join for community support
2. **GitHub Issues**: Report bugs at SDK repositories
3. **Documentation**: Check official docs at docs.kamino.finance
