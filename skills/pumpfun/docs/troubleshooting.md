# PumpFun Troubleshooting Guide

Common issues and solutions when working with PumpFun.

## Bonding Curve Issues

### "Account Data Too Small" Error

**Problem**: Transaction fails because bonding curve account needs extension.

**Solution**: Prepend `extendAccount` instruction when account size < 150 bytes.

```typescript
async function ensureAccountExtended(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<TransactionInstruction | null> {
  const accountInfo = await connection.getAccountInfo(bondingCurve);

  if (accountInfo && accountInfo.data.length < 150) {
    // Build extend_account instruction
    return createExtendAccountInstruction(PUMP_PROGRAM_ID, bondingCurve);
  }

  return null;
}

// Usage
const extendIx = await ensureAccountExtended(connection, bondingCurve);
if (extendIx) {
  tx.add(extendIx);
}
tx.add(buyInstruction);
```

### "Slippage Exceeded" Error

**Problem**: Price moved too much during transaction.

**Solutions**:

1. Increase slippage tolerance:
```typescript
// For buy: increase maxSolCost
const maxSolCost = expectedSolCost * 1.05n; // 5% slippage

// For sell: decrease minSolOutput
const minSolOutput = expectedSolOutput * 95n / 100n; // 5% slippage
```

2. Get fresh quote immediately before transaction:
```typescript
const quote = calculateBuyQuote(bondingCurveState, solAmountIn);
// Send transaction immediately after getting quote
```

3. Use priority fees to land faster:
```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

tx.add(
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })
);
```

### "Bonding Curve Complete" Error

**Problem**: Trying to trade on a graduated bonding curve.

**Solution**: Trade on PumpSwap AMM instead.

```typescript
// Check if bonding curve is complete
const bondingCurveData = await connection.getAccountInfo(bondingCurve);
const complete = parseBondingCurveComplete(bondingCurveData);

if (complete) {
  console.log('Token graduated - trade on PumpSwap instead');
  // Use PumpSwap swap instruction
} else {
  // Use bonding curve buy/sell
}
```

### "Invalid Fee Recipient" Error

**Problem**: Wrong fee recipient for Mayhem mode tokens.

**Solution**: Check `isMayhemMode` and use correct fee recipient.

```typescript
function getFeeRecipient(bondingCurve: BondingCurve): PublicKey {
  if (bondingCurve.isMayhemMode) {
    // Use random Mayhem fee recipient
    const index = Math.floor(Math.random() * MAYHEM_FEE_RECIPIENTS.length);
    return MAYHEM_FEE_RECIPIENTS[index];
  }
  return defaultFeeRecipient;
}
```

## PumpSwap AMM Issues

### "Pool Account Too Small" Error

**Problem**: Pool account needs extension (size < 300 bytes).

**Solution**: Prepend `extendAccount` instruction.

```typescript
const poolInfo = await connection.getAccountInfo(pool);
if (poolInfo && poolInfo.data.length < 300) {
  tx.add(createExtendAccountInstruction(PUMP_AMM_PROGRAM_ID, pool));
}
```

### "Insufficient Liquidity" Error

**Problem**: Not enough liquidity for the swap size.

**Solutions**:

1. Reduce swap amount
2. Check pool reserves before swapping:
```typescript
const poolState = await fetchPoolState(connection, pool);
console.log('Base reserve:', poolState.baseReserve);
console.log('Quote reserve:', poolState.quoteReserve);
```

### "Invalid Creator Vault" Error

**Problem**: Creator vault accounts not properly derived.

**Solution**: Ensure correct PDA derivation:

```typescript
// Creator vault authority PDA
const [creatorVaultAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator_vault'), coinCreator.toBuffer()],
  PUMP_AMM_PROGRAM_ID
);

// Creator vault ATA (allow off-curve)
const creatorVaultAta = getAssociatedTokenAddressSync(
  quoteMint,
  creatorVaultAuthority,
  true  // allowOwnerOffCurve = true for PDAs
);
```

## Transaction Issues

### "Transaction Too Large" Error

**Problem**: Transaction exceeds size limits.

**Solutions**:

1. Use versioned transactions with lookup tables
2. Split into multiple transactions
3. Remove unnecessary instructions

### "Blockhash Expired" Error

**Problem**: Transaction took too long to land.

**Solutions**:

1. Get fresh blockhash right before sending:
```typescript
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;
```

2. Add retry logic:
```typescript
async function sendWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  maxRetries = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      return await sendAndConfirmTransaction(connection, tx, signers);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Max retries exceeded');
}
```

### "Compute Budget Exceeded" Error

**Problem**: Transaction ran out of compute units.

**Solution**: Increase compute budget:

```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

// Recommended: 100,000 CU for buy/sell
tx.add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
);
```

## Fee Issues

### "Missing Fee Config Account" Error

**Problem**: Fee config accounts not included (required since Sept 2025).

**Solution**: Always include fee program and config accounts:

```typescript
// Add these to buy/sell instructions
keys.push(
  { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
  { pubkey: feeConfigPDA, isSigner: false, isWritable: false }
);
```

### Creator Fees Not Accumulating

**Problem**: Creator fees showing as zero.

**Checks**:

1. Verify `creatorFeeBasisPoints` is > 0 in global config
2. Ensure trades are happening on non-completed bonding curves OR canonical PumpSwap pools
3. Check the correct creator vault PDA

```typescript
const [creatorVault] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator-vault'), creator.toBuffer()],
  PUMP_PROGRAM_ID
);

const vaultBalance = await connection.getBalance(creatorVault);
console.log('Creator vault balance:', vaultBalance);
```

## SDK Issues

### "Module Not Found" Error

**Problem**: SDK packages not installed correctly.

**Solution**: Install all required packages:

```bash
npm install @pump-fun/pump-sdk @pump-fun/pump-swap-sdk
npm install @solana/web3.js @solana/spl-token
```

### TypeScript Type Errors

**Problem**: Type mismatches with SDK.

**Solution**: Ensure compatible versions:

```bash
npm install @solana/web3.js@^1.87.0
```

## Debugging Tips

### Simulate Before Sending

```typescript
const simulation = await connection.simulateTransaction(tx);

if (simulation.value.err) {
  console.error('Simulation failed:', simulation.value.err);
  console.log('Logs:', simulation.value.logs);
} else {
  console.log('Simulation successful');
  console.log('Units consumed:', simulation.value.unitsConsumed);
}
```

### Check Account State

```typescript
async function debugAccount(connection: Connection, address: PublicKey) {
  const info = await connection.getAccountInfo(address);

  if (!info) {
    console.log('Account does not exist');
    return;
  }

  console.log('Owner:', info.owner.toString());
  console.log('Lamports:', info.lamports);
  console.log('Data length:', info.data.length);
  console.log('Executable:', info.executable);
}
```

### Log Transaction Details

```typescript
function logTransaction(tx: Transaction) {
  console.log('Instructions:', tx.instructions.length);

  tx.instructions.forEach((ix, i) => {
    console.log(`\nInstruction ${i}:`);
    console.log('  Program:', ix.programId.toString());
    console.log('  Keys:', ix.keys.length);
    ix.keys.forEach((key, j) => {
      console.log(`    ${j}: ${key.pubkey.toString()} (signer: ${key.isSigner}, writable: ${key.isWritable})`);
    });
  });
}
```

## Getting Help

1. **PumpFun Documentation**: https://github.com/pump-fun/pump-public-docs
2. **IDL Files**: https://github.com/pump-fun/pump-public-docs/tree/main/idl
3. **Devnet Testing**: Always test on devnet first
