/**
 * DLMM Add Liquidity Example
 *
 * Demonstrates how to create a position and add liquidity to a DLMM pool.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function addLiquidity() {
  // 1. Setup connection
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');

  // 2. Load wallet
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 3. Create DLMM instance
  const dlmm = await DLMM.create(connection, POOL_ADDRESS);
  await dlmm.refetchStates();

  // 4. Get current active bin
  const activeBin = await dlmm.getActiveBin();
  console.log('Active Bin ID:', activeBin.binId);
  console.log('Current Price:', activeBin.price);

  // 5. Generate new position keypair
  const newPositionKeypair = Keypair.generate();
  console.log('\nNew Position:', newPositionKeypair.publicKey.toString());

  // 6. Define liquidity parameters
  const totalXAmount = new BN(100_000_000); // 100 tokens X (adjust decimals)
  const totalYAmount = new BN(100_000_000); // 100 tokens Y (adjust decimals)
  const binRange = 10; // Number of bins on each side of active bin

  // 7. Create position and add liquidity with strategy
  console.log('\nCreating position and adding liquidity...');
  console.log('Strategy: SpotBalanced');
  console.log('Bin Range:', activeBin.binId - binRange, 'to', activeBin.binId + binRange);

  const addLiquidityTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPositionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: {
      maxBinId: activeBin.binId + binRange,
      minBinId: activeBin.binId - binRange,
      strategyType: StrategyType.SpotBalanced,
    },
  });

  // 8. Execute transaction
  const txHash = await sendAndConfirmTransaction(
    connection,
    addLiquidityTx,
    [wallet, newPositionKeypair],
    { skipPreflight: false, commitment: 'confirmed' }
  );

  console.log('\nLiquidity added successfully!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 9. Verify position
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  console.log('\nTotal positions:', positions.length);

  const newPosition = positions.find(
    (p) => p.publicKey.toString() === newPositionKeypair.publicKey.toString()
  );

  if (newPosition) {
    console.log('\n=== New Position Details ===');
    console.log('Position Key:', newPosition.publicKey.toString());
    console.log('Total X:', newPosition.positionData.totalXAmount.toString());
    console.log('Total Y:', newPosition.positionData.totalYAmount.toString());
    console.log('Bins:', newPosition.positionData.positionBinData.length);
  }
}

// Example: Add liquidity to existing position
async function addToExistingPosition() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const dlmm = await DLMM.create(connection, POOL_ADDRESS);
  await dlmm.refetchStates();

  const activeBin = await dlmm.getActiveBin();

  // Get existing position
  const positions = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  if (positions.length === 0) {
    console.log('No existing positions found');
    return;
  }

  const existingPosition = positions[0];
  console.log('Adding to position:', existingPosition.publicKey.toString());

  // Add more liquidity
  const addLiquidityTx = await dlmm.addLiquidityByStrategy({
    positionPubKey: existingPosition.publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(50_000_000),
    totalYAmount: new BN(50_000_000),
    strategy: {
      maxBinId: activeBin.binId + 5,
      minBinId: activeBin.binId - 5,
      strategyType: StrategyType.SpotBalanced,
    },
  });

  const txHash = await sendAndConfirmTransaction(connection, addLiquidityTx, [wallet]);
  console.log('Added liquidity:', txHash);
}

// Run
addLiquidity()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
