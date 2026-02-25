/**
 * DAMM v2 Position Management Example
 *
 * Demonstrates how to create, manage, and remove liquidity positions.
 *
 * Prerequisites:
 * - npm install @meteora-ag/cp-amm-sdk @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function managePosition() {
  // 1. Setup
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 2. Initialize CpAmm
  const cpAmm = new CpAmm(connection);

  // 3. Fetch pool state
  const poolState = await cpAmm.fetchPoolState(POOL_ADDRESS);
  console.log('\nPool:', POOL_ADDRESS.toString());

  // 4. Create new position
  console.log('\n=== Creating Position ===');
  const positionKeypair = Keypair.generate();

  const createPositionTx = await cpAmm.createPosition({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
  });

  let tx = await createPositionTx.build();
  let txHash = await sendAndConfirmTransaction(connection, tx, [wallet, positionKeypair], {
    commitment: 'confirmed',
  });

  console.log('Position created:', positionKeypair.publicKey.toString());
  console.log('Transaction:', txHash);

  // 5. Get deposit quote
  const tokenAAmount = new BN(100_000_000); // 100 tokens
  const tokenBAmount = new BN(100_000_000); // 100 tokens
  const slippageBps = 100;

  const depositQuote = cpAmm.getDepositQuote({
    poolState,
    tokenAAmount,
    tokenBAmount,
    slippageBps,
  });

  console.log('\n=== Deposit Quote ===');
  console.log('Token A Required:', depositQuote.tokenAAmount.toString());
  console.log('Token B Required:', depositQuote.tokenBAmount.toString());
  console.log('Liquidity Delta:', depositQuote.liquidityDelta.toString());

  // 6. Add liquidity
  console.log('\n=== Adding Liquidity ===');

  const addLiquidityTx = await cpAmm.addLiquidity({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
    position: positionKeypair.publicKey,
    tokenAAmountIn: depositQuote.tokenAAmount,
    tokenBAmountIn: depositQuote.tokenBAmount,
    liquidityMin: depositQuote.liquidityDelta.mul(new BN(99)).div(new BN(100)), // 1% slippage
  });

  tx = await addLiquidityTx.build();
  txHash = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Liquidity added!');
  console.log('Transaction:', txHash);

  // 7. Fetch position state
  const positionState = await cpAmm.fetchPositionState(positionKeypair.publicKey);

  console.log('\n=== Position State ===');
  console.log('Liquidity:', positionState.liquidity.toString());
  console.log('Unlocked:', positionState.unlockedLiquidity.toString());
  console.log('Fee Owed A:', positionState.feeOwedA.toString());
  console.log('Fee Owed B:', positionState.feeOwedB.toString());

  // 8. Claim fees
  if (positionState.feeOwedA.gt(new BN(0)) || positionState.feeOwedB.gt(new BN(0))) {
    console.log('\n=== Claiming Fees ===');

    const claimFeeTx = await cpAmm.claimPositionFee({
      owner: wallet.publicKey,
      pool: POOL_ADDRESS,
      position: positionKeypair.publicKey,
    });

    tx = await claimFeeTx.build();
    txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log('Fees claimed:', txHash);
  }

  // 9. Remove partial liquidity
  console.log('\n=== Removing Partial Liquidity (50%) ===');

  const liquidityToRemove = positionState.liquidity.div(new BN(2));
  const withdrawQuote = cpAmm.getWithdrawQuote({
    poolState,
    positionState,
    liquidityAmount: liquidityToRemove,
    slippageBps,
  });

  console.log('Liquidity to remove:', liquidityToRemove.toString());
  console.log('Expected Token A:', withdrawQuote.tokenAAmount.toString());
  console.log('Expected Token B:', withdrawQuote.tokenBAmount.toString());

  const removeLiquidityTx = await cpAmm.removeLiquidity({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
    position: positionKeypair.publicKey,
    liquidityAmount: liquidityToRemove,
    tokenAAmountMin: withdrawQuote.minTokenAAmount,
    tokenBAmountMin: withdrawQuote.minTokenBAmount,
  });

  tx = await removeLiquidityTx.build();
  txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('Liquidity removed:', txHash);
}

// Split position
async function splitPosition() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);

  // Get existing position
  const positions = await cpAmm.getPositionsByUser(wallet.publicKey);
  if (positions.length === 0) {
    console.log('No positions found');
    return;
  }

  const existingPosition = positions[0];
  const newPositionKeypair = Keypair.generate();

  console.log('Splitting position:', existingPosition.owner.toString());
  console.log('New position:', newPositionKeypair.publicKey.toString());

  // Split 30% to new position
  const splitTx = await cpAmm.splitPosition({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
    position: existingPosition.owner, // Use actual position address
    percentage: 30,
    newPosition: newPositionKeypair.publicKey,
  });

  const tx = await splitTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet, newPositionKeypair]);
  console.log('Position split:', txHash);
}

// Merge positions
async function mergePositions() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);

  // Get user's positions in this pool
  const positions = await cpAmm.getUserPositionByPool(wallet.publicKey, POOL_ADDRESS);
  if (positions.length < 2) {
    console.log('Need at least 2 positions to merge');
    return;
  }

  console.log(`Merging ${positions.length - 1} positions into first position`);

  const destinationPosition = positions[0];
  const sourcePositions = positions.slice(1);

  const mergeTx = await cpAmm.mergePosition({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
    sourcePositions: sourcePositions.map((p) => p.owner), // Use actual position addresses
    destinationPosition: destinationPosition.owner,
  });

  const tx = await mergeTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('Positions merged:', txHash);
}

// Lock position with vesting
async function lockPosition() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);

  const positions = await cpAmm.getPositionsByUser(wallet.publicKey);
  if (positions.length === 0) {
    console.log('No positions found');
    return;
  }

  const position = positions[0];
  console.log('Locking position:', position.owner.toString());

  // Lock with 30-day vesting, 7-day cliff
  const lockTx = await cpAmm.lockPosition({
    owner: wallet.publicKey,
    pool: POOL_ADDRESS,
    position: position.owner,
    vestingDuration: new BN(86400 * 30), // 30 days
    cliffDuration: new BN(86400 * 7), // 7 days
  });

  const tx = await lockTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('Position locked:', txHash);
  console.log('Cliff ends:', new Date(Date.now() + 7 * 86400 * 1000).toISOString());
  console.log('Fully vested:', new Date(Date.now() + 30 * 86400 * 1000).toISOString());
}

// Run
managePosition()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
