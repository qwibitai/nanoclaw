/**
 * Meteora Zap SDK Examples
 *
 * Demonstrates single-token entry and exit for liquidity positions
 * using the Zap SDK with DLMM and DAMM v2 pools.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Zap } from "@meteora-ag/zap-sdk";
import DLMM from "@meteora-ag/dlmm";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const JUPITER_API_URL = "https://quote-api.jup.ag/v6";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY!;

// Common token mints
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Initialize connection and SDK
const connection = new Connection(RPC_URL);
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY || "[]"))
);

const zap = new Zap(connection, JUPITER_API_URL, JUPITER_API_KEY);

/**
 * Example 1: Zap SOL into a DLMM position
 */
async function zapInToDlmm(
  poolAddress: PublicKey,
  solAmount: BN
): Promise<string> {
  console.log("=== Zap Into DLMM Position ===");

  // Get DLMM pool info
  const dlmm = await DLMM.create(connection, poolAddress);
  const activeBin = await dlmm.getActiveBin();

  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Active Bin: ${activeBin.binId}`);
  console.log(`Current Price: ${activeBin.price}`);

  // Create new position keypair
  const positionKeypair = Keypair.generate();

  // Define position range around active bin
  const binRange = 10;
  const minBinId = activeBin.binId - binRange;
  const maxBinId = activeBin.binId + binRange;

  console.log(`Position range: ${minBinId} to ${maxBinId}`);
  console.log(`Zapping ${Number(solAmount) / 1e9} SOL...`);

  // Execute zap in
  const zapInTx = await zap.zapInDlmm({
    user: wallet.publicKey,
    lbPairAddress: poolAddress,
    inputMint: SOL_MINT,
    inputAmount: solAmount,
    slippageBps: 100, // 1%
    positionPubkey: positionKeypair.publicKey,
    strategyType: "SpotBalanced",
    minBinId,
    maxBinId,
  });

  const txId = await sendAndConfirmTransaction(connection, zapInTx, [
    wallet,
    positionKeypair,
  ]);

  console.log(`Zap complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);
  console.log(`Position: ${positionKeypair.publicKey.toBase58()}`);

  return txId;
}

/**
 * Example 2: Zap USDC into a DAMM v2 position
 */
async function zapInToDammV2(
  poolAddress: PublicKey,
  usdcAmount: BN
): Promise<string> {
  console.log("=== Zap Into DAMM v2 Position ===");

  // Get pool info
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(poolAddress);

  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Token A: ${poolState.tokenAMint.toBase58()}`);
  console.log(`Token B: ${poolState.tokenBMint.toBase58()}`);
  console.log(`Zapping ${Number(usdcAmount) / 1e6} USDC...`);

  // Create new position
  const createPositionTx = await cpAmm.createPosition({
    owner: wallet.publicKey,
    pool: poolAddress,
  });

  await sendAndConfirmTransaction(connection, createPositionTx.transaction, [
    wallet,
  ]);

  const positionAddress = createPositionTx.positionAddress;

  // Execute zap in
  const zapInTx = await zap.zapInDammV2({
    user: wallet.publicKey,
    poolAddress: poolAddress,
    inputMint: USDC_MINT,
    inputAmount: usdcAmount,
    slippageBps: 100,
    positionPubkey: positionAddress,
  });

  const txId = await sendAndConfirmTransaction(connection, zapInTx, [wallet]);

  console.log(`Zap complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);
  console.log(`Position: ${positionAddress.toBase58()}`);

  return txId;
}

/**
 * Example 3: Zap out from DLMM to SOL
 */
async function zapOutFromDlmm(
  poolAddress: PublicKey,
  positionAddress: PublicKey,
  percentage: number = 100
): Promise<string> {
  console.log("=== Zap Out from DLMM ===");

  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Position: ${positionAddress.toBase58()}`);
  console.log(`Zapping out ${percentage}% to SOL...`);

  const zapOutTx = await zap.zapOutDlmm({
    user: wallet.publicKey,
    lbPairAddress: poolAddress,
    outputMint: SOL_MINT,
    positionPubkey: positionAddress,
    percentageToZap: percentage,
    slippageBps: 100,
  });

  const txId = await sendAndConfirmTransaction(connection, zapOutTx, [wallet]);

  console.log(`Zap out complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 4: Zap out from DAMM v2 to USDC
 */
async function zapOutFromDammV2(
  poolAddress: PublicKey,
  positionAddress: PublicKey,
  percentage: number = 100
): Promise<string> {
  console.log("=== Zap Out from DAMM v2 ===");

  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Position: ${positionAddress.toBase58()}`);
  console.log(`Zapping out ${percentage}% to USDC...`);

  const zapOutTx = await zap.zapOutDammV2({
    user: wallet.publicKey,
    poolAddress: poolAddress,
    outputMint: USDC_MINT,
    positionPubkey: positionAddress,
    percentageToZap: percentage,
    slippageBps: 100,
  });

  const txId = await sendAndConfirmTransaction(connection, zapOutTx, [wallet]);

  console.log(`Zap out complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 5: Zap out using Jupiter for optimal routing
 */
async function zapOutViaJupiter(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amount: BN
): Promise<string> {
  console.log("=== Zap Out via Jupiter ===");

  // Get Jupiter quote
  const quote = await zap.getJupiterQuote({
    inputMint,
    outputMint,
    amount,
    slippageBps: 50,
  });

  console.log(`Input: ${Number(quote.inAmount) / 1e9}`);
  console.log(`Output: ${Number(quote.outAmount) / 1e6}`);
  console.log(`Price Impact: ${quote.priceImpactPct}%`);

  // Get token programs
  const inputTokenProgram = await zap.getTokenProgramFromMint(
    connection,
    inputMint
  );
  const outputTokenProgram = await zap.getTokenProgramFromMint(
    connection,
    outputMint
  );

  const zapOutTx = await zap.zapOutThroughJupiter({
    user: wallet.publicKey,
    inputMint,
    outputMint,
    inputTokenProgram,
    outputTokenProgram,
    jupiterSwapResponse: quote,
    maxSwapAmount: amount,
    percentageToZap: 100,
  });

  const txId = await sendAndConfirmTransaction(connection, zapOutTx, [wallet]);

  console.log(`Zap out complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 6: Complete zap workflow
 */
async function completeZapWorkflow(dlmmPoolAddress: PublicKey): Promise<void> {
  console.log("=== Complete Zap Workflow ===\n");

  try {
    // Step 1: Zap in 0.1 SOL
    console.log("Step 1: Zapping into DLMM position...\n");
    const dlmm = await DLMM.create(connection, dlmmPoolAddress);
    const activeBin = await dlmm.getActiveBin();

    const positionKeypair = Keypair.generate();
    const solAmount = new BN(100_000_000); // 0.1 SOL

    const zapInTx = await zap.zapInDlmm({
      user: wallet.publicKey,
      lbPairAddress: dlmmPoolAddress,
      inputMint: SOL_MINT,
      inputAmount: solAmount,
      slippageBps: 100,
      positionPubkey: positionKeypair.publicKey,
      strategyType: "SpotBalanced",
      minBinId: activeBin.binId - 5,
      maxBinId: activeBin.binId + 5,
    });

    await sendAndConfirmTransaction(connection, zapInTx, [
      wallet,
      positionKeypair,
    ]);
    console.log(`Position created: ${positionKeypair.publicKey.toBase58()}\n`);

    // Step 2: Wait briefly
    console.log("Step 2: Waiting for position to accrue fees...\n");
    await new Promise((r) => setTimeout(r, 5000));

    // Step 3: Zap out 50% to USDC
    console.log("Step 3: Zapping out 50% to USDC...\n");
    const zapOut50Tx = await zap.zapOutDlmm({
      user: wallet.publicKey,
      lbPairAddress: dlmmPoolAddress,
      outputMint: USDC_MINT,
      positionPubkey: positionKeypair.publicKey,
      percentageToZap: 50,
      slippageBps: 100,
    });

    await sendAndConfirmTransaction(connection, zapOut50Tx, [wallet]);
    console.log("Zapped out 50% to USDC\n");

    // Step 4: Zap out remaining to SOL
    console.log("Step 4: Zapping out remaining 100% to SOL...\n");
    const zapOutRemainingTx = await zap.zapOutDlmm({
      user: wallet.publicKey,
      lbPairAddress: dlmmPoolAddress,
      outputMint: SOL_MINT,
      positionPubkey: positionKeypair.publicKey,
      percentageToZap: 100,
      slippageBps: 100,
    });

    await sendAndConfirmTransaction(connection, zapOutRemainingTx, [wallet]);
    console.log("Position fully closed\n");

    console.log("=== Workflow Complete ===");
  } catch (error) {
    console.error("Workflow failed:", error);
    throw error;
  }
}

// Main execution
async function main() {
  console.log("Meteora Zap SDK Examples\n");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  // Example pool addresses (replace with actual addresses)
  const DLMM_POOL = new PublicKey("YOUR_DLMM_POOL_ADDRESS");
  const DAMM_V2_POOL = new PublicKey("YOUR_DAMM_V2_POOL_ADDRESS");

  // Uncomment examples to run:

  // await zapInToDlmm(DLMM_POOL, new BN(100_000_000)); // 0.1 SOL
  // await zapInToDammV2(DAMM_V2_POOL, new BN(10_000_000)); // 10 USDC
  // await zapOutFromDlmm(DLMM_POOL, POSITION_ADDRESS, 100);
  // await zapOutFromDammV2(DAMM_V2_POOL, POSITION_ADDRESS, 50);
  // await completeZapWorkflow(DLMM_POOL);
}

main().catch(console.error);
