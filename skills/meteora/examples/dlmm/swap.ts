/**
 * DLMM Swap Example
 *
 * Demonstrates how to execute a token swap on a Meteora DLMM pool.
 *
 * Prerequisites:
 * - npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js @solana/spl-token
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';

// Configuration
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = new PublicKey('YOUR_POOL_ADDRESS');

async function executeSwap() {
  // 1. Setup connection
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');

  // 2. Load wallet (use your preferred method)
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.WALLET_SECRET_KEY || '[]'))
  );

  console.log('Wallet:', wallet.publicKey.toString());

  // 3. Create DLMM instance
  const dlmm = await DLMM.create(connection, POOL_ADDRESS);

  // 4. Refresh state
  await dlmm.refetchStates();

  // 5. Get current price
  const activeBin = await dlmm.getActiveBin();
  console.log('Current Active Bin:', activeBin.binId);
  console.log('Current Price:', activeBin.price);

  // 6. Prepare swap parameters
  const swapAmount = new BN(1_000_000); // 1 token (adjust decimals)
  const swapForY = true; // true = swap token X for Y, false = swap Y for X
  const slippageBps = 100; // 1% slippage

  // 7. Get bin arrays for swap
  const binArrays = await dlmm.getBinArrayForSwap(swapForY);

  // 8. Get swap quote
  const swapQuote = dlmm.swapQuote(swapAmount, swapForY, slippageBps, binArrays);

  console.log('\n=== Swap Quote ===');
  console.log('Amount In:', swapQuote.consumedInAmount.toString());
  console.log('Amount Out:', swapQuote.outAmount.toString());
  console.log('Min Amount Out:', swapQuote.minOutAmount.toString());
  console.log('Fee:', swapQuote.fee.toString());
  console.log('Price Impact:', swapQuote.priceImpact.toString(), '%');

  // 9. Get token mints from pool
  const tokenXMint = dlmm.tokenX.publicKey;
  const tokenYMint = dlmm.tokenY.publicKey;

  // 10. Build swap transaction
  const swapTx = await dlmm.swap({
    inToken: swapForY ? tokenXMint : tokenYMint,
    outToken: swapForY ? tokenYMint : tokenXMint,
    inAmount: swapAmount,
    minOutAmount: swapQuote.minOutAmount,
    lbPair: dlmm.pubkey,
    user: wallet.publicKey,
    binArraysPubkey: swapQuote.binArraysPubkey,
  });

  // 11. Execute swap
  console.log('\nExecuting swap...');
  const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet], {
    skipPreflight: false,
    commitment: 'confirmed',
  });

  console.log('Swap successful!');
  console.log('Transaction:', txHash);
  console.log(`Explorer: https://solscan.io/tx/${txHash}`);

  // 12. Verify new price
  await dlmm.refetchStates();
  const newActiveBin = await dlmm.getActiveBin();
  console.log('\nNew Active Bin:', newActiveBin.binId);
  console.log('New Price:', newActiveBin.price);
}

// Run the swap
executeSwap()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
