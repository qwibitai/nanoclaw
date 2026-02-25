/**
 * DAMM v2 Create Pool Example
 *
 * Demonstrates how to create a new DAMM v2 pool with custom configuration.
 *
 * Prerequisites:
 * - npm install @meteora-ag/cp-amm-sdk @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

async function createPool() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Initialize CpAmm
  const cpAmm = new CpAmm(connection);

  // 3. Define token mints (replace with actual mints)
  const tokenAMint = new PublicKey('TOKEN_A_MINT');
  const tokenBMint = new PublicKey('TOKEN_B_MINT');

  // 4. Define pool parameters
  const tokenAAmount = new BN(1_000_000_000); // 1000 tokens (adjust decimals)
  const tokenBAmount = new BN(1_000_000_000); // 1000 tokens (adjust decimals)

  // 5. Create custom pool with specific fee structure
  console.log('\nCreating custom pool...');
  console.log('Token A:', tokenAMint.toString());
  console.log('Token B:', tokenBMint.toString());

  const createPoolTx = await cpAmm.createCustomPool({
    creator: wallet.publicKey,
    tokenAMint,
    tokenBMint,
    tokenAAmount,
    tokenBAmount,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: new BN(2500000), // 0.25% fee
        numberOfPeriod: 0,
        reductionFactor: new BN(0),
        periodFrequency: new BN(0),
        feeSchedulerMode: 0, // Time-based scheduler
      },
      dynamicFee: null, // No dynamic fees
      protocolFeePercent: 20, // 20% of fees to protocol
      partnerFeePercent: 0, // No partner fee
      referralFeePercent: 20, // 20% referral rebate
      dynamicFeeConfig: null,
    },
    hasAlphaVault: false, // No alpha vault integration
    activationType: 0, // 0 = slot-based, 1 = timestamp-based
    activationPoint: null, // null = immediate activation
    collectFeeMode: 0, // Standard fee collection
  });

  // 6. Build and send transaction
  const tx = await createPoolTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('\nPool created successfully!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 7. Find the new pool
  const pools = await cpAmm.getAllPools();
  const newPool = pools.find(
    (p) =>
      (p.tokenAMint.equals(tokenAMint) && p.tokenBMint.equals(tokenBMint)) ||
      (p.tokenAMint.equals(tokenBMint) && p.tokenBMint.equals(tokenAMint))
  );

  if (newPool) {
    console.log('\n=== New Pool Details ===');
    console.log('Pool Address: [derived from state]');
    console.log('Token A Vault:', newPool.tokenAVault.toString());
    console.log('Token B Vault:', newPool.tokenBVault.toString());
    console.log('Liquidity:', newPool.liquidity.toString());
  }
}

// Create pool from existing config
async function createPoolFromConfig() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);

  // Use a predefined config address
  const configAddress = new PublicKey('CONFIG_ADDRESS');

  const createPoolTx = await cpAmm.createPool({
    creator: wallet.publicKey,
    configAddress,
    tokenAMint: new PublicKey('TOKEN_A_MINT'),
    tokenBMint: new PublicKey('TOKEN_B_MINT'),
    tokenAAmount: new BN(1_000_000_000),
    tokenBAmount: new BN(1_000_000_000),
  });

  const tx = await createPoolTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('Pool created:', txHash);
}

// Create pool with delayed activation
async function createPoolWithDelayedActivation() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);

  // Activate pool 1 hour from now (timestamp-based)
  const activationTime = Math.floor(Date.now() / 1000) + 3600;

  const createPoolTx = await cpAmm.createCustomPool({
    creator: wallet.publicKey,
    tokenAMint: new PublicKey('TOKEN_A_MINT'),
    tokenBMint: new PublicKey('TOKEN_B_MINT'),
    tokenAAmount: new BN(1_000_000_000),
    tokenBAmount: new BN(1_000_000_000),
    poolFees: {
      baseFee: {
        cliffFeeNumerator: new BN(2500000),
        numberOfPeriod: 0,
        reductionFactor: new BN(0),
        periodFrequency: new BN(0),
        feeSchedulerMode: 0,
      },
      dynamicFee: null,
      protocolFeePercent: 20,
      partnerFeePercent: 0,
      referralFeePercent: 20,
      dynamicFeeConfig: null,
    },
    hasAlphaVault: false,
    activationType: 1, // 1 = timestamp-based activation
    activationPoint: new BN(activationTime),
    collectFeeMode: 0,
  });

  const tx = await createPoolTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);

  console.log('Pool created with delayed activation!');
  console.log('Transaction:', txHash);
  console.log('Activation time:', new Date(activationTime * 1000).toISOString());
}

// Run
createPool()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
