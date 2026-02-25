# Stake-for-Fee (M3M3) SDK Reference

Complete API reference for the `@meteora-ag/m3m3` package.

## Overview

The M3M3 (Stake-for-Fee) SDK enables staking tokens to earn a share of trading fees from Dynamic AMM pools. Top stakers receive fee distributions proportional to their stake.

## Installation

```bash
npm install @meteora-ag/m3m3 @coral-xyz/anchor @solana/web3.js @solana/spl-token @solana/spl-token-registry
```

## StakeForFee Class

### Static Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `create(connection, poolAddress)` | Create StakeForFee instance | `Connection`, `PublicKey` | `Promise<StakeForFee>` |

### Instance Properties

| Property | Type | Description |
|----------|------|-------------|
| `accountStates` | `AccountStates` | Current account states |
| `poolAddress` | `PublicKey` | Pool address |

### Instance Methods

| Method | Description | Parameters | Returns |
|--------|-------------|------------|---------|
| `stake(amount, user)` | Stake tokens | `BN`, `PublicKey` | `Promise<Transaction>` |
| `unstake(amount, destination, user)` | Initiate unstake | `BN`, `PublicKey`, `PublicKey` | `Promise<Transaction>` |
| `cancelUnstake(escrow, user)` | Cancel pending unstake | `PublicKey`, `PublicKey` | `Promise<Transaction>` |
| `withdraw(escrow, user)` | Complete withdrawal | `PublicKey`, `PublicKey` | `Promise<Transaction>` |
| `claimFee(user, maxAmount?)` | Claim accumulated fees | `PublicKey`, `BN?` | `Promise<Transaction>` |
| `getUserStakeAndClaimBalance(user)` | Get user balance info | `PublicKey` | `Promise<UserBalance>` |
| `getUnstakePeriod()` | Get lock duration | - | `number` |
| `refreshStates()` | Refresh all states | - | `Promise<void>` |

## Types

### AccountStates

```typescript
interface AccountStates {
  feeVault: FeeVaultState;
  stakePool: StakePoolState;
  userStake: UserStakeState | null;
}
```

### FeeVaultState

```typescript
interface FeeVaultState {
  pool: PublicKey;
  stakeMint: PublicKey;
  feeVault: PublicKey;
  totalStaked: BN;
  totalFees: BN;
  configuration: FeeVaultConfig;
}

interface FeeVaultConfig {
  unstakeLockDuration: BN;  // Lock period in seconds
  secondsToFullUnlock: BN;
  startClaimFeeTimestamp: BN;
}
```

### StakePoolState

```typescript
interface StakePoolState {
  stakeMint: PublicKey;
  vault: PublicKey;
  totalStaked: BN;
  rewardIndex: BN;
  lastUpdateTime: BN;
}
```

### UserStakeState

```typescript
interface UserStakeState {
  owner: PublicKey;
  stakeAmount: BN;
  rewardIndex: BN;
  pendingReward: BN;
  lastStakeTime: BN;
}
```

### UserBalance

```typescript
interface UserBalance {
  stakedAmount: BN;      // Current staked tokens
  claimableFees: BN;     // Fees available to claim
  pendingUnstake: BN;    // Amount in unstake escrow
  escrows: EscrowInfo[]; // Pending unstake escrows
}

interface EscrowInfo {
  address: PublicKey;
  amount: BN;
  unlockTime: BN;
  canWithdraw: boolean;
}
```

## Usage Examples

### Initialize and Check Balance

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { StakeForFee } from '@meteora-ag/m3m3';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const poolAddress = new PublicKey('POOL_ADDRESS');

// Create instance
const m3m3 = await StakeForFee.create(connection, poolAddress);

// Get user balance
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

console.log('Staked Amount:', balance.stakedAmount.toString());
console.log('Claimable Fees:', balance.claimableFees.toString());
console.log('Pending Unstake:', balance.pendingUnstake.toString());

// Check unstake period
const unstakePeriod = m3m3.getUnstakePeriod();
console.log('Unstake Lock Period:', unstakePeriod, 'seconds');
console.log('Lock Period (days):', unstakePeriod / 86400);
```

### Stake Tokens

```typescript
const stakeAmount = new BN(1_000_000_000); // 1 token (9 decimals)

const stakeTx = await m3m3.stake(stakeAmount, wallet.publicKey);
const sig = await sendAndConfirmTransaction(connection, stakeTx, [wallet]);

console.log('Stake successful:', sig);

// Verify new balance
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
console.log('New staked amount:', balance.stakedAmount.toString());
```

### Claim Fees

```typescript
// Get claimable amount
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

if (balance.claimableFees.gt(new BN(0))) {
  // Claim all fees (pass null for max)
  const claimTx = await m3m3.claimFee(wallet.publicKey, null);
  const sig = await sendAndConfirmTransaction(connection, claimTx, [wallet]);

  console.log('Claimed fees:', balance.claimableFees.toString());
  console.log('Transaction:', sig);
} else {
  console.log('No fees to claim');
}

// Or claim specific amount
const partialClaimTx = await m3m3.claimFee(
  wallet.publicKey,
  new BN(500_000_000) // Claim 0.5 tokens
);
```

### Unstake Tokens

```typescript
// Initiate unstake (starts lock period)
const unstakeAmount = new BN(500_000_000); // 0.5 tokens

// Get destination token account
const destinationAta = await getAssociatedTokenAddress(
  stakeMint,
  wallet.publicKey
);

const unstakeTx = await m3m3.unstake(
  unstakeAmount,
  destinationAta,
  wallet.publicKey
);

const sig = await sendAndConfirmTransaction(connection, unstakeTx, [wallet]);
console.log('Unstake initiated:', sig);
console.log('Lock period:', m3m3.getUnstakePeriod(), 'seconds');
```

### Cancel Unstake

```typescript
// Get pending escrows
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

for (const escrow of balance.escrows) {
  if (!escrow.canWithdraw) {
    // Can cancel if not yet withdrawable
    const cancelTx = await m3m3.cancelUnstake(
      escrow.address,
      wallet.publicKey
    );

    await sendAndConfirmTransaction(connection, cancelTx, [wallet]);
    console.log('Cancelled unstake for escrow:', escrow.address.toString());
  }
}
```

### Withdraw After Lock Period

```typescript
// Get escrows that can be withdrawn
const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

for (const escrow of balance.escrows) {
  if (escrow.canWithdraw) {
    const withdrawTx = await m3m3.withdraw(
      escrow.address,
      wallet.publicKey
    );

    const sig = await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
    console.log('Withdrawn:', escrow.amount.toString());
    console.log('Transaction:', sig);
  } else {
    const now = Date.now() / 1000;
    const remaining = escrow.unlockTime.toNumber() - now;
    console.log('Escrow unlocks in:', remaining, 'seconds');
  }
}
```

### Monitor Staking Rewards

```typescript
async function monitorRewards(m3m3: StakeForFee, user: PublicKey, intervalMs: number = 60000) {
  let previousFees: BN | null = null;

  setInterval(async () => {
    await m3m3.refreshStates();
    const balance = await m3m3.getUserStakeAndClaimBalance(user);

    console.log('=== Staking Status ===');
    console.log('Staked:', balance.stakedAmount.toString());
    console.log('Claimable:', balance.claimableFees.toString());

    if (previousFees) {
      const earned = balance.claimableFees.sub(previousFees);
      if (earned.gt(new BN(0))) {
        console.log('Earned this period:', earned.toString());
      }
    }

    previousFees = balance.claimableFees;

    // Check pending unstakes
    for (const escrow of balance.escrows) {
      const unlockDate = new Date(escrow.unlockTime.toNumber() * 1000);
      console.log(`Escrow ${escrow.address.toString().slice(0, 8)}...:`);
      console.log(`  Amount: ${escrow.amount.toString()}`);
      console.log(`  Unlocks: ${unlockDate.toISOString()}`);
      console.log(`  Can withdraw: ${escrow.canWithdraw}`);
    }
  }, intervalMs);
}
```

### Calculate APY

```typescript
async function calculateStakingAPY(m3m3: StakeForFee): Promise<number> {
  const feeVault = m3m3.accountStates.feeVault;

  // Get historical fee data (would need to track over time)
  const totalStaked = feeVault.totalStaked;
  const totalFees = feeVault.totalFees;

  if (totalStaked.eq(new BN(0))) return 0;

  // Simple calculation: (fees / staked) * 365 * 100
  // Note: This is a simplified calculation - real APY depends on
  // fee accumulation rate over time
  const ratio = totalFees.mul(new BN(10000)).div(totalStaked);
  const annualized = ratio.toNumber() / 100; // Adjust based on time period

  return annualized;
}
```

### Full Staking Flow Example

```typescript
async function stakingFlow(
  m3m3: StakeForFee,
  wallet: Keypair,
  stakeAmount: BN
) {
  console.log('=== Starting Staking Flow ===');

  // 1. Check initial balance
  let balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
  console.log('Initial staked:', balance.stakedAmount.toString());

  // 2. Stake tokens
  console.log('\nStaking', stakeAmount.toString(), 'tokens...');
  const stakeTx = await m3m3.stake(stakeAmount, wallet.publicKey);
  await sendAndConfirmTransaction(connection, stakeTx, [wallet]);

  // 3. Verify stake
  balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
  console.log('New staked amount:', balance.stakedAmount.toString());

  // 4. Wait and claim fees (in practice, wait for fees to accumulate)
  console.log('\nChecking claimable fees...');
  if (balance.claimableFees.gt(new BN(0))) {
    const claimTx = await m3m3.claimFee(wallet.publicKey, null);
    await sendAndConfirmTransaction(connection, claimTx, [wallet]);
    console.log('Claimed:', balance.claimableFees.toString());
  }

  // 5. Initiate unstake
  console.log('\nInitiating unstake...');
  const unstakeAmount = stakeAmount.div(new BN(2)); // Unstake half
  const destinationAta = await getAssociatedTokenAddress(
    m3m3.accountStates.feeVault.stakeMint,
    wallet.publicKey
  );

  const unstakeTx = await m3m3.unstake(unstakeAmount, destinationAta, wallet.publicKey);
  await sendAndConfirmTransaction(connection, unstakeTx, [wallet]);

  // 6. Check escrow status
  balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
  console.log('\nPending unstakes:');
  for (const escrow of balance.escrows) {
    console.log(`  Amount: ${escrow.amount.toString()}`);
    console.log(`  Unlocks: ${new Date(escrow.unlockTime.toNumber() * 1000)}`);
  }

  console.log('\n=== Flow Complete ===');
}
```

## Program Address

| Network | Address |
|---------|---------|
| Mainnet-beta | `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP` |

## Resources

- [NPM Package](https://www.npmjs.com/package/@meteora-ag/m3m3)
- [GitHub Repository](https://github.com/MeteoraAg/stake-for-fee-sdk)
- [Meteora Documentation](https://docs.meteora.ag)
