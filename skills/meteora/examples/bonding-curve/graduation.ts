/**
 * Dynamic Bonding Curve - Graduation Example
 *
 * Demonstrates how to migrate a graduated pool to DAMM v1 or v2.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { DynamicBondingCurve } from '@meteora-ag/dynamic-bonding-curve-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function checkGraduationStatus() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 2. Fetch pool state
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  console.log('=== Graduation Status ===\n');
  console.log('Pool:', POOL_ADDRESS.toString());
  console.log('Base Mint:', poolState.baseMint.toString());
  console.log('Quote Mint:', poolState.quoteMint.toString());
  console.log('');
  console.log('Graduated:', poolState.graduated);
  console.log('Current Market Cap:', poolState.currentMarketCap.toString(), 'lamports');
  console.log('Graduation Threshold:', poolState.graduationThreshold.toString(), 'lamports');

  // Calculate progress
  const progress = poolState.currentMarketCap
    .mul(new BN(10000))
    .div(poolState.graduationThreshold);
  console.log('Progress:', (progress.toNumber() / 100).toFixed(2) + '%');

  if (!poolState.graduated) {
    const remaining = poolState.graduationThreshold.sub(poolState.currentMarketCap);
    console.log('\nRemaining to graduate:', (remaining.toNumber() / 1e9).toFixed(4), 'SOL');

    // Estimate SOL needed
    console.log('\nTo graduate, the market cap must reach the threshold.');
    console.log('This happens through trading activity on the bonding curve.');
  } else {
    console.log('\nGraduated at:', new Date(poolState.graduatedAt!.toNumber() * 1000).toISOString());
    console.log('\nThis pool can now be migrated to DAMM!');
  }

  return poolState.graduated;
}

async function migrateToDAMMV2() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 2. Check if graduated
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  if (!poolState.graduated) {
    console.log('Pool has not graduated yet!');
    console.log('Current progress:', poolState.currentMarketCap.toString());
    console.log('Threshold:', poolState.graduationThreshold.toString());
    return;
  }

  // 3. Migrate to DAMM v2
  console.log('=== Migrating to DAMM v2 ===\n');
  console.log('Pool:', POOL_ADDRESS.toString());

  const migrateTx = await dbc.migrateToDAMMV2({
    pool: POOL_ADDRESS,
    payer: wallet.publicKey,
  });

  const txHash = await sendAndConfirmTransaction(connection, migrateTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('\nMigration successful!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  console.log('\nThe pool is now a DAMM v2 pool!');
  console.log('You can now trade using the DAMM v2 SDK.');
}

async function migrateToDAMMV1() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // 2. Check if graduated
  const poolState = await dbc.fetchPoolState(POOL_ADDRESS);

  if (!poolState.graduated) {
    console.log('Pool has not graduated yet!');
    return;
  }

  console.log('=== Migrating to DAMM v1 (Multi-step) ===\n');

  // Step 1: Create metadata
  console.log('Step 1: Creating metadata...');
  const metadataTx = await dbc.createMetadata({
    pool: POOL_ADDRESS,
    payer: wallet.publicKey,
  });

  let txHash = await sendAndConfirmTransaction(connection, metadataTx, [wallet], {
    commitment: 'confirmed',
  });
  console.log('Metadata created:', txHash);

  // Step 2: Execute migration
  console.log('\nStep 2: Executing migration...');
  const migrateTx = await dbc.migrateToDAMMV1({
    pool: POOL_ADDRESS,
    payer: wallet.publicKey,
  });

  txHash = await sendAndConfirmTransaction(connection, migrateTx, [wallet], {
    commitment: 'confirmed',
  });
  console.log('Migration executed:', txHash);

  console.log('\nMigration to DAMM v1 complete!');
}

async function lockLPTokens() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  // Lock duration: 1 year
  const lockDuration = new BN(86400 * 365);

  console.log('=== Locking LP Tokens ===\n');
  console.log('Pool:', POOL_ADDRESS.toString());
  console.log('Lock duration:', lockDuration.toNumber() / 86400, 'days');

  const lockTx = await dbc.lockLpTokens({
    pool: POOL_ADDRESS,
    payer: wallet.publicKey,
    lockDuration,
  });

  const txHash = await sendAndConfirmTransaction(connection, lockTx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('\nLP tokens locked!');
  console.log('Transaction:', txHash);

  const unlockDate = new Date(Date.now() + lockDuration.toNumber() * 1000);
  console.log('Unlock date:', unlockDate.toISOString());
}

async function claimLPTokens() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dbc = new DynamicBondingCurve(connection, 'confirmed');

  console.log('=== Claiming LP Tokens ===\n');
  console.log('Pool:', POOL_ADDRESS.toString());

  // Note: This will fail if lock period hasn't expired
  try {
    const claimTx = await dbc.claimLpTokens({
      pool: POOL_ADDRESS,
      payer: wallet.publicKey,
    });

    const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet], {
      commitment: 'confirmed',
    });

    console.log('LP tokens claimed!');
    console.log('Transaction:', txHash);
  } catch (error) {
    console.log('Failed to claim - lock period may not have expired');
    console.log('Error:', error);
  }
}

// Full graduation workflow
async function fullGraduationWorkflow() {
  console.log('=== Full Graduation Workflow ===\n');

  // 1. Check status
  const isGraduated = await checkGraduationStatus();

  if (!isGraduated) {
    console.log('\nPool not graduated. Continue trading to reach threshold.');
    console.log('Or use the Manual Migrator: https://migrator.meteora.ag');
    return;
  }

  // 2. Migrate (choose v1 or v2)
  console.log('\n--- Starting Migration ---\n');

  // Uncomment the migration you want:
  await migrateToDAMMV2();
  // await migrateToDAMMV1();

  // 3. Optionally lock LP tokens
  // await lockLPTokens();

  console.log('\n=== Workflow Complete ===');
}

// Run
fullGraduationWorkflow()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
