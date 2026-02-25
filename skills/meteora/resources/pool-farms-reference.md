# Pool Farms SDK Reference

The Pool Farms SDK enables creating and managing liquidity mining farms on Meteora DAMM v1 pools.

## Installation

```bash
npm install @meteora-ag/farming
# or
yarn add @meteora-ag/farming
```

---

## Initialization

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { FarmImpl } from '@meteora-ag/farming';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const farmAddress = new PublicKey('FARM_ADDRESS');

const farm = await FarmImpl.create(connection, farmAddress);
```

---

## Farm Operations

### deposit

Deposit LP tokens to start earning farming rewards.

```typescript
const depositTx = await farm.deposit(
  owner: PublicKey,
  amount: BN
);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `owner` | `PublicKey` | Wallet address |
| `amount` | `BN` | LP tokens to deposit |

**Example:**

```typescript
import BN from 'bn.js';

const lpAmount = new BN(1_000_000_000); // LP tokens to stake

const depositTx = await farm.deposit(
  wallet.publicKey,
  lpAmount
);

await sendAndConfirmTransaction(connection, depositTx, [wallet]);
console.log('Staked LP tokens in farm');
```

---

### withdraw

Withdraw LP tokens from the farm.

```typescript
const withdrawTx = await farm.withdraw(
  owner: PublicKey,
  amount: BN
);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `owner` | `PublicKey` | Wallet address |
| `amount` | `BN` | LP tokens to withdraw |

**Example:**

```typescript
const withdrawAmount = new BN(500_000_000);

const withdrawTx = await farm.withdraw(
  wallet.publicKey,
  withdrawAmount
);

await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
console.log('Withdrew LP tokens from farm');
```

---

### claim

Claim accumulated farming rewards.

```typescript
const claimTx = await farm.claim(owner: PublicKey);
```

**Example:**

```typescript
const claimTx = await farm.claim(wallet.publicKey);
await sendAndConfirmTransaction(connection, claimTx, [wallet]);
console.log('Claimed farming rewards');
```

---

### getPendingRewards

Get pending rewards for a user.

```typescript
const pendingRewards = await farm.getPendingRewards(owner: PublicKey);
// Returns: BN
```

**Example:**

```typescript
const pending = await farm.getPendingRewards(wallet.publicKey);
console.log('Pending rewards:', pending.toString());
```

---

### getUserStakeInfo

Get user's staking information.

```typescript
const stakeInfo = await farm.getUserStakeInfo(owner: PublicKey);
```

**Returns:**

```typescript
{
  amount: BN;           // Staked LP tokens
  rewardDebt: BN;       // Reward calculation helper
  pendingRewards: BN;   // Unclaimed rewards
}
```

---

## Farm Queries

### Farm State

```typescript
// Get farm state
const farmState = farm.state;

console.log('Total Staked:', farmState.totalStaked.toString());
console.log('Reward Per Second:', farmState.rewardPerSecond.toString());
console.log('Start Time:', farmState.startTime.toString());
console.log('End Time:', farmState.endTime.toString());
```

### Reward Info

```typescript
const rewardInfo = farm.rewardInfo;

console.log('Reward Mint:', rewardInfo.mint.toString());
console.log('Accumulated:', rewardInfo.accumulated.toString());
console.log('Per Share:', rewardInfo.perShare.toString());
```

---

## Complete Example

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { FarmImpl } from '@meteora-ag/farming';
import AmmImpl from '@meteora-ag/dynamic-amm';
import BN from 'bn.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.fromSecretKey(/* your key */);

async function farmingWorkflow() {
  const poolAddress = new PublicKey('POOL_ADDRESS');
  const farmAddress = new PublicKey('FARM_ADDRESS');

  // Step 1: Add liquidity to pool
  const pool = await AmmImpl.create(connection, poolAddress);

  const depositQuote = pool.getDepositQuote(
    new BN(1_000_000_000),
    new BN(1_000_000_000),
    true,
    100
  );

  const addLiqTx = await pool.deposit(
    wallet.publicKey,
    new BN(1_000_000_000),
    new BN(1_000_000_000),
    depositQuote.minLpAmount
  );
  await sendAndConfirmTransaction(connection, addLiqTx, [wallet]);
  console.log('Added liquidity to pool');

  // Step 2: Stake LP tokens in farm
  const farm = await FarmImpl.create(connection, farmAddress);
  const lpBalance = await pool.getUserBalance(wallet.publicKey);

  const stakeTx = await farm.deposit(wallet.publicKey, lpBalance);
  await sendAndConfirmTransaction(connection, stakeTx, [wallet]);
  console.log('Staked LP tokens in farm');

  // Step 3: Wait and check pending rewards
  await new Promise(r => setTimeout(r, 60000)); // Wait 1 minute

  const pending = await farm.getPendingRewards(wallet.publicKey);
  console.log('Pending rewards:', pending.toString());

  // Step 4: Claim rewards
  const claimTx = await farm.claim(wallet.publicKey);
  await sendAndConfirmTransaction(connection, claimTx, [wallet]);
  console.log('Claimed rewards');

  // Step 5: Unstake and remove liquidity
  const stakeInfo = await farm.getUserStakeInfo(wallet.publicKey);

  const unstakeTx = await farm.withdraw(wallet.publicKey, stakeInfo.amount);
  await sendAndConfirmTransaction(connection, unstakeTx, [wallet]);
  console.log('Unstaked LP tokens');

  const newLpBalance = await pool.getUserBalance(wallet.publicKey);
  const withdrawQuote = pool.getWithdrawQuote(newLpBalance, 100);

  const withdrawTx = await pool.withdraw(
    wallet.publicKey,
    newLpBalance,
    withdrawQuote.minTokenAAmount,
    withdrawQuote.minTokenBAmount
  );
  await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
  console.log('Withdrew liquidity');
}

farmingWorkflow().catch(console.error);
```

---

## Harvest and Compound

```typescript
async function harvestAndCompound(
  pool: AmmImpl,
  farm: FarmImpl,
  wallet: Keypair
) {
  // Claim rewards
  const claimTx = await farm.claim(wallet.publicKey);
  await sendAndConfirmTransaction(connection, claimTx, [wallet]);

  // Get reward token balance (assume it's one of pool tokens)
  // Add rewards as liquidity
  const rewardBalance = /* get reward token balance */;

  // Deposit rewards as liquidity
  const depositQuote = pool.getDepositQuote(
    rewardBalance,
    new BN(0),
    false,
    100
  );

  const depositTx = await pool.deposit(
    wallet.publicKey,
    rewardBalance,
    new BN(0),
    depositQuote.minLpAmount
  );
  await sendAndConfirmTransaction(connection, depositTx, [wallet]);

  // Stake new LP tokens
  const newLp = await pool.getUserBalance(wallet.publicKey);
  const stakeTx = await farm.deposit(wallet.publicKey, newLp);
  await sendAndConfirmTransaction(connection, stakeTx, [wallet]);

  console.log('Compounded rewards');
}
```

---

## Error Handling

```typescript
try {
  const stakeTx = await farm.deposit(wallet.publicKey, amount);
  await sendAndConfirmTransaction(connection, stakeTx, [wallet]);
} catch (error) {
  if (error.message.includes('InsufficientBalance')) {
    console.error('Not enough LP tokens');
  } else if (error.message.includes('FarmNotActive')) {
    console.error('Farm has not started yet');
  } else if (error.message.includes('FarmEnded')) {
    console.error('Farm rewards have ended');
  } else {
    throw error;
  }
}
```

---

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `InsufficientBalance` | Not enough LP tokens | Add more liquidity first |
| `FarmNotActive` | Farm hasn't started | Wait for farm start time |
| `FarmEnded` | Farming period over | Farm no longer distributes rewards |
| `NoStake` | No staked tokens | Deposit LP tokens first |
| `NothingToClaim` | No pending rewards | Wait for rewards to accumulate |

---

## DAMM v2 Farming Note

DAMM v2 has built-in farming support without requiring a separate SDK:

```typescript
// DAMM v2 farm operations are integrated
const cpAmm = new CpAmm(connection);

// Initialize reward
const initRewardTx = await cpAmm.initializeReward({
  pool: poolAddress,
  rewardMint,
  rewardDuration: new BN(86400 * 7),
  funder: wallet.publicKey,
});

// Claim rewards
const claimRewardTx = await cpAmm.claimReward({
  owner: wallet.publicKey,
  pool: poolAddress,
  position: positionAddress,
  rewardIndex: 0,
});
```

---

## Related Resources

- [DAMM v1 SDK](https://github.com/MeteoraAg/damm-v1-sdk)
- [DAMM v2 SDK](https://github.com/MeteoraAg/cp-amm-sdk)
- [Meteora Documentation](https://docs.meteora.ag)
