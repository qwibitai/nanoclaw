# Meteora Migration Guide

Complete guide to migrating pools between Meteora protocols.

## Dynamic Bonding Curve to DAMM Migration

### Migration Flow

```
DBC Pool (Active) → Graduation Threshold → Migration → DAMM Pool (Active)
```

### Prerequisites for Migration

1. **Pool must be graduated**
   - Market cap reached graduation threshold
   - Check with `poolState.graduated === true`

2. **Migration not yet executed**
   - Pool can only be migrated once

### Checking Graduation Status

```typescript
const dbc = new DynamicBondingCurve(connection, 'confirmed');
const poolState = await dbc.fetchPoolState(poolAddress);

console.log('Graduated:', poolState.graduated);
console.log('Market Cap:', poolState.currentMarketCap.toString());
console.log('Threshold:', poolState.graduationThreshold.toString());

const progress = poolState.currentMarketCap
  .mul(new BN(100))
  .div(poolState.graduationThreshold);
console.log('Progress:', progress.toString(), '%');
```

### Migration to DAMM v2 (Recommended)

DAMM v2 is the newer, more feature-rich protocol:

```typescript
const migrateTx = await dbc.migrateToDAMMV2({
  pool: poolAddress,
  payer: wallet.publicKey,
});

const txHash = await sendAndConfirmTransaction(connection, migrateTx, [wallet]);
console.log('Migrated to DAMM v2:', txHash);
```

**Benefits of DAMM v2:**
- Simpler migration (single transaction)
- Advanced position management
- Vesting and locking features
- Better fee customization

### Migration to DAMM v1 (Legacy)

DAMM v1 migration requires multiple steps:

```typescript
// Step 1: Create metadata
const metadataTx = await dbc.createMetadata({
  pool: poolAddress,
  payer: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, metadataTx, [wallet]);

// Step 2: Execute migration
const migrateTx = await dbc.migrateToDAMMV1({
  pool: poolAddress,
  payer: wallet.publicKey,
});
await sendAndConfirmTransaction(connection, migrateTx, [wallet]);

// Step 3 (Optional): Lock LP tokens
const lockTx = await dbc.lockLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
  lockDuration: new BN(86400 * 365), // 1 year
});
await sendAndConfirmTransaction(connection, lockTx, [wallet]);
```

### Post-Migration

After migration, the pool operates on DAMM:

1. **Trading continues** - No interruption for traders
2. **Liquidity preserved** - All liquidity transfers
3. **New SDK** - Use DAMM SDK for interactions

```typescript
// After migration, use DAMM SDK
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

const cpAmm = new CpAmm(connection);
const poolState = await cpAmm.fetchPoolState(newPoolAddress);
```

---

## Manual Migration Tool

For pools that haven't auto-graduated, use the web interface:

- **Mainnet**: https://migrator.meteora.ag
- **Devnet**: https://migrator.meteora.ag/devnet

### When to Use Manual Migrator

1. Pool graduated but migration not triggered
2. Need to migrate before auto-graduation
3. Troubleshooting failed migrations

---

## LP Token Locking

After DAMM v1 migration, lock LP tokens for trust:

### Lock Types

| Type | Duration | Unlockable |
|------|----------|------------|
| Temporary | Custom (e.g., 1 year) | Yes, after duration |
| Permanent | Forever | No |

### Locking LP Tokens

```typescript
// Temporary lock
const lockTx = await dbc.lockLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
  lockDuration: new BN(86400 * 365), // 1 year in seconds
});

await sendAndConfirmTransaction(connection, lockTx, [wallet]);

const unlockDate = new Date(Date.now() + 86400 * 365 * 1000);
console.log('Unlocks at:', unlockDate.toISOString());
```

### Claiming Locked LP Tokens

After lock period expires:

```typescript
const claimTx = await dbc.claimLpTokens({
  pool: poolAddress,
  payer: wallet.publicKey,
});

await sendAndConfirmTransaction(connection, claimTx, [wallet]);
```

---

## DLMM to DAMM Position Migration

If moving positions between protocols:

### Step 1: Remove DLMM Liquidity

```typescript
const dlmm = await DLMM.create(connection, dlmmPoolAddress);
const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

for (const position of positions) {
  const binIds = position.positionData.positionBinData.map(b => b.binId);

  const removeTx = await dlmm.removeLiquidity({
    position: position.publicKey,
    user: wallet.publicKey,
    binIds,
    bps: new BN(10000), // 100%
    shouldClaimAndClose: true,
  });

  await sendAndConfirmTransaction(connection, removeTx, [wallet]);
}
```

### Step 2: Add DAMM v2 Liquidity

```typescript
const cpAmm = new CpAmm(connection);
const poolState = await cpAmm.fetchPoolState(dammPoolAddress);

// Create position
const createTx = await cpAmm.createPosition({
  owner: wallet.publicKey,
  pool: dammPoolAddress,
});
await sendAndConfirmTransaction(connection, await createTx.build(), [wallet]);

// Add liquidity
const addTx = await cpAmm.addLiquidity({
  owner: wallet.publicKey,
  pool: dammPoolAddress,
  position: newPositionAddress,
  tokenAAmountIn: tokenAAmount,
  tokenBAmountIn: tokenBAmount,
  liquidityMin: new BN(0),
});
await sendAndConfirmTransaction(connection, await addTx.build(), [wallet]);
```

---

## Migration Checklist

### Before Migration

- [ ] Verify pool has graduated
- [ ] Check wallet has SOL for transaction fees
- [ ] Understand target protocol (v1 vs v2)
- [ ] Review LP locking strategy

### During Migration

- [ ] Execute migration transaction
- [ ] Wait for confirmation
- [ ] Verify new pool state

### After Migration

- [ ] Update SDK references in code
- [ ] Test trading on new pool
- [ ] Lock LP tokens if planned
- [ ] Update documentation/announcements

---

## Troubleshooting

### Migration Failed

1. **Check graduation status**
   ```typescript
   const poolState = await dbc.fetchPoolState(poolAddress);
   if (!poolState.graduated) {
     console.log('Pool not graduated');
   }
   ```

2. **Check if already migrated**
   - Try fetching as DAMM pool

3. **Use Manual Migrator**
   - https://migrator.meteora.ag

### Transaction Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `PoolNotGraduated` | Threshold not reached | Wait for more trading |
| `AlreadyMigrated` | Pool already migrated | Use DAMM SDK |
| `InsufficientFunds` | Not enough SOL | Add SOL to wallet |

### Finding Migrated Pool

After migration, the pool address changes. Find the new address:

1. Check transaction details on explorer
2. Query DAMM pools by token mints
3. Use Meteora UI to find pool
