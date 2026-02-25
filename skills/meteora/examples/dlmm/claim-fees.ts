/**
 * DLMM Claim Fees and Rewards Example
 *
 * Demonstrates how to claim swap fees and LM rewards from DLMM positions.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function claimFeesAndRewards() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Create DLMM instance
  const dlmm = await DLMM.create(connection, POOL_ADDRESS);

  // 3. Get user positions
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

  if (positions.length === 0) {
    console.log('No positions found for this wallet');
    return;
  }

  console.log(`Found ${positions.length} position(s)\n`);

  // 4. Check claimable amounts for each position
  for (const position of positions) {
    console.log('=== Position:', position.publicKey.toString().slice(0, 8) + '... ===');

    // Get claimable swap fees
    const claimableFees = await DLMM.getClaimableSwapFee(connection, position.publicKey);
    console.log('Claimable Fee X:', claimableFees.feeX.toString());
    console.log('Claimable Fee Y:', claimableFees.feeY.toString());

    // Get claimable LM rewards
    const claimableRewards = await DLMM.getClaimableLMReward(connection, position.publicKey);
    console.log('Claimable Reward 1:', claimableRewards.rewardOne.toString());
    console.log('Claimable Reward 2:', claimableRewards.rewardTwo.toString());
    console.log('');
  }

  // 5. Claim swap fees from first position
  const positionToClaim = positions[0];
  const fees = await DLMM.getClaimableSwapFee(connection, positionToClaim.publicKey);

  if (fees.feeX.gt(fees.feeX.sub(fees.feeX)) || fees.feeY.gt(fees.feeY.sub(fees.feeY))) {
    console.log('Claiming swap fees from position:', positionToClaim.publicKey.toString());

    const claimFeeTx = await dlmm.claimSwapFee({
      owner: wallet.publicKey,
      position: positionToClaim.publicKey,
    });

    const feeTxHash = await sendAndConfirmTransaction(connection, claimFeeTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('Fees claimed! Transaction:', feeTxHash);
  } else {
    console.log('No fees to claim');
  }

  // 6. Claim LM rewards
  const rewards = await DLMM.getClaimableLMReward(connection, positionToClaim.publicKey);

  if (
    rewards.rewardOne.gt(rewards.rewardOne.sub(rewards.rewardOne)) ||
    rewards.rewardTwo.gt(rewards.rewardTwo.sub(rewards.rewardTwo))
  ) {
    console.log('\nClaiming LM rewards...');

    const claimRewardTx = await dlmm.claimLMReward({
      owner: wallet.publicKey,
      position: positionToClaim.publicKey,
    });

    const rewardTxHash = await sendAndConfirmTransaction(connection, claimRewardTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('Rewards claimed! Transaction:', rewardTxHash);
  } else {
    console.log('\nNo LM rewards to claim');
  }
}

// Claim from all positions
async function claimAllFromAllPositions() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dlmm = await DLMM.create(connection, POOL_ADDRESS);
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

  if (positions.length === 0) {
    console.log('No positions found');
    return;
  }

  // Claim all fees from all positions
  console.log('Claiming fees from all positions...');
  const claimAllFeesTx = await dlmm.claimAllSwapFee({
    owner: wallet.publicKey,
    positions: positions.map((p) => p.publicKey),
  });

  const feesTxHash = await sendAndConfirmTransaction(connection, claimAllFeesTx, [wallet]);
  console.log('All fees claimed:', feesTxHash);

  // Claim all LM rewards
  console.log('\nClaiming LM rewards from all positions...');
  const claimAllRewardsTx = await dlmm.claimAllLMRewards({
    owner: wallet.publicKey,
    positions: positions.map((p) => p.publicKey),
  });

  const rewardsTxHash = await sendAndConfirmTransaction(connection, claimAllRewardsTx, [wallet]);
  console.log('All rewards claimed:', rewardsTxHash);
}

// Claim everything in one transaction
async function claimEverything() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dlmm = await DLMM.create(connection, POOL_ADDRESS);
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);

  if (positions.length === 0) {
    console.log('No positions found');
    return;
  }

  console.log('Claiming all fees and rewards...');
  const claimAllTx = await dlmm.claimAllRewards({
    owner: wallet.publicKey,
    positions: positions.map((p) => p.publicKey),
  });

  const txHash = await sendAndConfirmTransaction(connection, claimAllTx, [wallet]);
  console.log('Everything claimed:', txHash);
}

// Run
claimFeesAndRewards()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
