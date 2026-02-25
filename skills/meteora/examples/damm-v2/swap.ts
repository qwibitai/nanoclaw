/**
 * DAMM v2 Swap Example
 *
 * Demonstrates how to execute swaps on DAMM v2 pools.
 *
 * Prerequisites:
 * - npm install @meteora-ag/cp-amm-sdk @solana/web3.js
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function executeSwap() {
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

  console.log('\n=== Pool Info ===');
  console.log('Token A:', poolState.tokenAMint.toString());
  console.log('Token B:', poolState.tokenBMint.toString());
  console.log('Liquidity:', poolState.liquidity.toString());

  // Get current price
  const tokenADecimals = 9; // Adjust based on actual token
  const tokenBDecimals = 6; // Adjust based on actual token
  const currentPrice = cpAmm.getPriceFromSqrtPrice(
    poolState.sqrtPrice,
    tokenADecimals,
    tokenBDecimals
  );
  console.log('Current Price:', currentPrice.toString());

  // 4. Get swap quote
  const inputAmount = new BN(1_000_000); // 1 token (adjust decimals)
  const slippageBps = 100; // 1% slippage

  const quote = cpAmm.getQuote({
    poolState,
    inputTokenMint: poolState.tokenAMint,
    outputTokenMint: poolState.tokenBMint,
    amount: inputAmount,
    slippageBps,
    swapMode: SwapMode.ExactIn,
  });

  console.log('\n=== Swap Quote ===');
  console.log('Input Amount:', quote.inputAmount.toString());
  console.log('Output Amount:', quote.outputAmount.toString());
  console.log('Minimum Output:', quote.minimumOutputAmount.toString());
  console.log('Price Impact:', quote.priceImpact.toString(), '%');
  console.log('Fee:', quote.fee.toString());
  console.log('Fee %:', quote.feePercent.toString(), '%');

  // 5. Execute swap
  console.log('\nExecuting swap...');

  const swapTx = await cpAmm.swap({
    payer: wallet.publicKey,
    pool: POOL_ADDRESS,
    inputTokenMint: poolState.tokenAMint,
    outputTokenMint: poolState.tokenBMint,
    amountIn: inputAmount,
    minimumAmountOut: quote.minimumOutputAmount,
    referralAccount: null, // Optional referral
  });

  const tx = await swapTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });

  console.log('Swap successful!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 6. Verify new price
  const newPoolState = await cpAmm.fetchPoolState(POOL_ADDRESS);
  const newPrice = cpAmm.getPriceFromSqrtPrice(
    newPoolState.sqrtPrice,
    tokenADecimals,
    tokenBDecimals
  );
  console.log('\nNew Price:', newPrice.toString());
}

// Swap with ExactOut mode
async function swapExactOut() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(POOL_ADDRESS);

  // Get quote for exact output
  const outputAmount = new BN(1_000_000); // Want exactly 1 token out
  const slippageBps = 100;

  const quote = cpAmm.getQuote({
    poolState,
    inputTokenMint: poolState.tokenAMint,
    outputTokenMint: poolState.tokenBMint,
    amount: outputAmount,
    slippageBps,
    swapMode: SwapMode.ExactOut, // Exact output mode
  });

  console.log('=== ExactOut Quote ===');
  console.log('Output (exact):', outputAmount.toString());
  console.log('Max Input Required:', quote.maximumInputAmount.toString());
  console.log('Price Impact:', quote.priceImpact.toString(), '%');

  // Execute swap (using swap2 for exact out)
  const swapTx = await cpAmm.swap2({
    payer: wallet.publicKey,
    pool: POOL_ADDRESS,
    inputTokenMint: poolState.tokenAMint,
    outputTokenMint: poolState.tokenBMint,
    amount: outputAmount,
    otherAmountThreshold: quote.maximumInputAmount,
    swapMode: SwapMode.ExactOut,
    referralAccount: null,
  });

  const tx = await swapTx.build();
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('Swap successful:', txHash);
}

// Calculate price impact before swap
async function analyzeSwapImpact() {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(POOL_ADDRESS);

  const amounts = [
    new BN(1_000_000), // Small
    new BN(10_000_000), // Medium
    new BN(100_000_000), // Large
    new BN(1_000_000_000), // Very Large
  ];

  console.log('=== Price Impact Analysis ===\n');

  for (const amount of amounts) {
    const quote = cpAmm.getQuote({
      poolState,
      inputTokenMint: poolState.tokenAMint,
      outputTokenMint: poolState.tokenBMint,
      amount,
      slippageBps: 100,
      swapMode: SwapMode.ExactIn,
    });

    console.log(`Input: ${amount.toString().padEnd(15)} | Output: ${quote.outputAmount.toString().padEnd(15)} | Impact: ${quote.priceImpact.toString()}%`);
  }
}

// Run
executeSwap()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
