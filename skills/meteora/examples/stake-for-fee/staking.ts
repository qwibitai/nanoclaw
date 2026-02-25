/**
 * Stake-for-Fee (M3M3) - Staking Example
 *
 * Demonstrates how to stake tokens and earn fees from trading activity.
 *
 * Prerequisites:
 * - npm install @meteora-ag/m3m3 @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { StakeForFee } from '@meteora-ag/m3m3';
import { getAssociatedTokenAddress } from '@solana/spl-token';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_M3M3_POOL_ADDRESS');

async function stakingOperations() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Create M3M3 instance
  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);

  // 3. Get pool info
  const feeVault = m3m3.accountStates.feeVault;
  const stakePool = m3m3.accountStates.stakePool;

  console.log('\n=== Pool Info ===');
  console.log('Stake Mint:', feeVault.stakeMint.toString());
  console.log('Total Staked:', feeVault.totalStaked.toString());
  console.log('Total Fees:', feeVault.totalFees.toString());

  // Get unstake period
  const unstakePeriod = m3m3.getUnstakePeriod();
  console.log('Unstake Lock Period:', unstakePeriod, 'seconds');
  console.log('Lock Period (days):', (unstakePeriod / 86400).toFixed(1));

  // 4. Get user balance
  const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

  console.log('\n=== Your Balance ===');
  console.log('Staked Amount:', balance.stakedAmount.toString());
  console.log('Claimable Fees:', balance.claimableFees.toString());
  console.log('Pending Unstake:', balance.pendingUnstake.toString());

  // Show pending escrows
  if (balance.escrows.length > 0) {
    console.log('\nPending Unstake Escrows:');
    for (const escrow of balance.escrows) {
      const unlockDate = new Date(escrow.unlockTime.toNumber() * 1000);
      console.log(`  - Amount: ${escrow.amount.toString()}`);
      console.log(`    Unlock: ${unlockDate.toISOString()}`);
      console.log(`    Can Withdraw: ${escrow.canWithdraw}`);
    }
  }

  // 5. Stake tokens
  const stakeAmount = new BN(1_000_000_000); // 1 token (adjust decimals)

  console.log('\n=== Staking ===');
  console.log('Amount:', stakeAmount.toString());

  const stakeTx = await m3m3.stake(stakeAmount, wallet.publicKey);
  let txHash = await sendAndConfirmTransaction(connection, stakeTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Stake successful!');
  console.log('Transaction:', txHash);

  // Verify new balance
  await m3m3.refreshStates();
  const newBalance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);
  console.log('New staked amount:', newBalance.stakedAmount.toString());

  // 6. Claim fees (if any available)
  if (newBalance.claimableFees.gt(new BN(0))) {
    console.log('\n=== Claiming Fees ===');
    console.log('Claimable:', newBalance.claimableFees.toString());

    const claimTx = await m3m3.claimFee(wallet.publicKey, null); // null = claim all
    txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('Fees claimed!');
    console.log('Transaction:', txHash);
  }

  // 7. Initiate unstake (partial)
  const unstakeAmount = stakeAmount.div(new BN(2)); // Unstake 50%

  console.log('\n=== Initiating Unstake ===');
  console.log('Amount:', unstakeAmount.toString());
  console.log('Lock period:', unstakePeriod, 'seconds');

  // Get destination token account
  const stakeMint = feeVault.stakeMint;
  const destinationAta = await getAssociatedTokenAddress(stakeMint, wallet.publicKey);

  const unstakeTx = await m3m3.unstake(unstakeAmount, destinationAta, wallet.publicKey);
  txHash = await sendAndConfirmTransaction(connection, unstakeTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Unstake initiated!');
  console.log('Transaction:', txHash);

  const unlockTime = new Date(Date.now() + unstakePeriod * 1000);
  console.log('Withdrawable at:', unlockTime.toISOString());
}

// Claim fees only
async function claimFees() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);
  const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

  if (balance.claimableFees.eq(new BN(0))) {
    console.log('No fees to claim');
    return;
  }

  console.log('Claiming fees:', balance.claimableFees.toString());

  const claimTx = await m3m3.claimFee(wallet.publicKey, null);
  const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet]);

  console.log('Claimed!', txHash);
}

// Cancel pending unstake
async function cancelUnstake() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);
  const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

  // Find escrows that haven't unlocked yet
  const pendingEscrows = balance.escrows.filter((e) => !e.canWithdraw);

  if (pendingEscrows.length === 0) {
    console.log('No pending unstakes to cancel');
    return;
  }

  for (const escrow of pendingEscrows) {
    console.log('Cancelling unstake:', escrow.amount.toString());

    const cancelTx = await m3m3.cancelUnstake(escrow.address, wallet.publicKey);
    const txHash = await sendAndConfirmTransaction(connection, cancelTx, [wallet]);

    console.log('Cancelled!', txHash);
  }
}

// Withdraw completed unstakes
async function withdrawUnstaked() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);
  const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

  // Find withdrawable escrows
  const withdrawableEscrows = balance.escrows.filter((e) => e.canWithdraw);

  if (withdrawableEscrows.length === 0) {
    console.log('No completed unstakes to withdraw');

    // Show pending ones
    for (const escrow of balance.escrows) {
      const remaining = escrow.unlockTime.toNumber() - Date.now() / 1000;
      if (remaining > 0) {
        console.log(`Escrow unlocks in: ${Math.ceil(remaining / 60)} minutes`);
      }
    }
    return;
  }

  let totalWithdrawn = new BN(0);

  for (const escrow of withdrawableEscrows) {
    console.log('Withdrawing:', escrow.amount.toString());

    const withdrawTx = await m3m3.withdraw(escrow.address, wallet.publicKey);
    const txHash = await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);

    console.log('Withdrawn!', txHash);
    totalWithdrawn = totalWithdrawn.add(escrow.amount);
  }

  console.log('\nTotal withdrawn:', totalWithdrawn.toString());
}

// Monitor staking rewards
async function monitorRewards() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);

  console.log('=== Monitoring Staking Rewards ===\n');

  let previousFees: BN | null = null;

  const poll = async () => {
    await m3m3.refreshStates();
    const balance = await m3m3.getUserStakeAndClaimBalance(wallet.publicKey);

    console.log('Time:', new Date().toISOString());
    console.log('Staked:', balance.stakedAmount.toString());
    console.log('Claimable:', balance.claimableFees.toString());

    if (previousFees) {
      const earned = balance.claimableFees.sub(previousFees);
      if (earned.gt(new BN(0))) {
        console.log('Earned since last check:', earned.toString());
      }
    }

    previousFees = balance.claimableFees;

    // Pending unstakes
    if (balance.escrows.length > 0) {
      console.log('Pending unstakes:', balance.escrows.length);
      for (const escrow of balance.escrows) {
        const now = Date.now() / 1000;
        const remaining = escrow.unlockTime.toNumber() - now;
        if (remaining > 0) {
          console.log(`  - ${escrow.amount.toString()} (${Math.ceil(remaining / 60)}m remaining)`);
        } else {
          console.log(`  - ${escrow.amount.toString()} (READY)`);
        }
      }
    }

    console.log('---');
  };

  await poll();
  setInterval(poll, 30000); // Every 30 seconds
}

// Calculate APY
async function calculateAPY() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const m3m3 = await StakeForFee.create(connection, POOL_ADDRESS);

  const feeVault = m3m3.accountStates.feeVault;

  console.log('=== APY Calculation ===\n');
  console.log('Total Staked:', feeVault.totalStaked.toString());
  console.log('Total Fees Generated:', feeVault.totalFees.toString());

  if (feeVault.totalStaked.eq(new BN(0))) {
    console.log('No stake - cannot calculate APY');
    return;
  }

  // Note: This is a simplified calculation
  // Real APY depends on fee generation rate over time
  const ratio = feeVault.totalFees.mul(new BN(10000)).div(feeVault.totalStaked);
  console.log('Fee/Stake Ratio:', (ratio.toNumber() / 100).toFixed(2), '%');

  console.log('\nNote: Actual APY depends on:');
  console.log('- Trading volume');
  console.log('- Fee rate');
  console.log('- Time period');
  console.log('- Your stake share');
}

// Run
stakingOperations()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
