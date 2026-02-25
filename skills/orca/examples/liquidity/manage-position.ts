/**
 * Orca Whirlpools: Manage Position Examples
 *
 * This file demonstrates how to manage existing liquidity positions:
 * - Increase liquidity
 * - Decrease liquidity
 * - Close positions
 */

import {
  increaseLiquidity,
  increaseLiquidityInstructions,
  decreaseLiquidity,
  decreaseLiquidityInstructions,
  closePosition,
  closePositionInstructions,
  fetchPositionsForOwner,
  setWhirlpoolsConfig,
  setRpc,
  setPayerFromBytes,
} from "@orca-so/whirlpools";
import { createSolanaRpc, address, Address } from "@solana/kit";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPath: process.env.WALLET_PATH || "./keypair.json",
  network: "solanaMainnet" as const,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function loadWallet() {
  const keyPairBytes = new Uint8Array(
    JSON.parse(fs.readFileSync(CONFIG.walletPath, "utf8"))
  );
  return await setPayerFromBytes(keyPairBytes);
}

function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 4)}`;
}

// ============================================================================
// FETCH POSITIONS
// ============================================================================

/**
 * Example 1: Fetch all positions for a wallet
 */
async function fetchMyPositions() {
  console.log("\n=== Fetch My Positions ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const positions = await fetchPositionsForOwner(rpc, wallet.address);

  console.log("Found", positions.length, "positions");

  for (const position of positions) {
    console.log("\nPosition:", position.positionMint);
    console.log("  Whirlpool:", position.whirlpool);
    console.log("  Liquidity:", position.liquidity.toString());
    console.log("  Tick range:", position.tickLowerIndex, "to", position.tickUpperIndex);
    console.log("  Fees owed A:", position.feeOwedA.toString());
    console.log("  Fees owed B:", position.feeOwedB.toString());
  }

  return positions;
}

// ============================================================================
// INCREASE LIQUIDITY
// ============================================================================

/**
 * Example 2: Increase liquidity in a position
 */
async function increasePositionLiquidity(positionMint: Address) {
  console.log("\n=== Increase Position Liquidity ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Specify additional liquidity (using token A amount)
  const param = { tokenA: 100_000_000n }; // 0.1 SOL
  const slippageTolerance = 100; // 1%

  const { instructions, quote } = await increaseLiquidityInstructions(
    rpc,
    positionMint,
    param,
    slippageTolerance,
    wallet
  );

  console.log("Increase Liquidity Quote:");
  console.log("  Additional Token A:", formatAmount(quote.tokenEstA, 9));
  console.log("  Additional Token B:", formatAmount(quote.tokenEstB, 6));
  console.log("  Max Token A:", formatAmount(quote.tokenMaxA, 9));
  console.log("  Max Token B:", formatAmount(quote.tokenMaxB, 6));
  console.log("  Instructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await increaseLiquidity(rpc, positionMint, param, slippageTolerance, wallet);
  // console.log("Transaction:", txId);
}

/**
 * Example 3: Increase liquidity with specific token B amount
 */
async function increaseWithTokenB(positionMint: Address) {
  console.log("\n=== Increase Liquidity with Token B ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Specify using 50 USDC
  const param = { tokenB: 50_000_000n }; // 50 USDC (6 decimals)
  const slippageTolerance = 100;

  const { quote } = await increaseLiquidityInstructions(
    rpc,
    positionMint,
    param,
    slippageTolerance,
    wallet
  );

  console.log("Adding 50 USDC worth of liquidity:");
  console.log("  Token A needed:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B needed:", formatAmount(quote.tokenEstB, 6));
}

// ============================================================================
// DECREASE LIQUIDITY
// ============================================================================

/**
 * Example 4: Decrease liquidity in a position
 */
async function decreasePositionLiquidity(positionMint: Address) {
  console.log("\n=== Decrease Position Liquidity ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Specify liquidity to remove (can use liquidity, tokenA, or tokenB)
  const param = { liquidity: 500_000_000n };
  const slippageTolerance = 100;

  const { instructions, quote } = await decreaseLiquidityInstructions(
    rpc,
    positionMint,
    param,
    slippageTolerance,
    wallet
  );

  console.log("Decrease Liquidity Quote:");
  console.log("  Token A received:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B received:", formatAmount(quote.tokenEstB, 6));
  console.log("  Min Token A:", formatAmount(quote.tokenMinA, 9));
  console.log("  Min Token B:", formatAmount(quote.tokenMinB, 6));
  console.log("  Instructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await decreaseLiquidity(rpc, positionMint, param, slippageTolerance, wallet);
  // console.log("Transaction:", txId);
}

/**
 * Example 5: Withdraw specific token amount
 */
async function withdrawTokenAmount(positionMint: Address) {
  console.log("\n=== Withdraw Specific Token Amount ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Withdraw 0.5 SOL worth of liquidity
  const param = { tokenA: 500_000_000n }; // 0.5 SOL
  const slippageTolerance = 100;

  const { quote } = await decreaseLiquidityInstructions(
    rpc,
    positionMint,
    param,
    slippageTolerance,
    wallet
  );

  console.log("Withdrawing ~0.5 SOL worth:");
  console.log("  Token A to receive:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B to receive:", formatAmount(quote.tokenEstB, 6));
}

// ============================================================================
// CLOSE POSITION
// ============================================================================

/**
 * Example 6: Close a position (withdraw all liquidity and burn NFT)
 */
async function closeMyPosition(positionMint: Address) {
  console.log("\n=== Close Position ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const slippageTolerance = 100;

  const { instructions, quote, feesQuote } = await closePositionInstructions(
    rpc,
    positionMint,
    slippageTolerance,
    wallet
  );

  console.log("Close Position Details:");
  console.log("  Token A returned:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B returned:", formatAmount(quote.tokenEstB, 6));
  console.log("  Min Token A:", formatAmount(quote.tokenMinA, 9));
  console.log("  Min Token B:", formatAmount(quote.tokenMinB, 6));
  console.log("\nFees Collected:");
  console.log("  Fee Token A:", formatAmount(feesQuote.feeOwedA, 9));
  console.log("  Fee Token B:", formatAmount(feesQuote.feeOwedB, 6));
  console.log("\nInstructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await closePosition(rpc, positionMint, slippageTolerance, wallet);
  // console.log("Position closed:", txId);
}

/**
 * Example 7: Close position with error handling
 */
async function closePositionSafely(positionMint: Address) {
  console.log("\n=== Close Position Safely ===");

  try {
    await setWhirlpoolsConfig(CONFIG.network);
    await setRpc(CONFIG.rpcUrl);
    const wallet = await loadWallet();
    const rpc = createSolanaRpc(CONFIG.rpcUrl);

    const { quote, feesQuote } = await closePositionInstructions(
      rpc,
      positionMint,
      100,
      wallet
    );

    console.log("Ready to close position");
    console.log("  Will receive:", formatAmount(quote.tokenEstA, 9), "Token A");
    console.log("  Will receive:", formatAmount(quote.tokenEstB, 6), "Token B");
    console.log("  Plus fees:", formatAmount(feesQuote.feeOwedA, 9), "Token A");
    console.log("  Plus fees:", formatAmount(feesQuote.feeOwedB, 6), "Token B");
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("PositionNotFound")) {
        console.error("Error: Position not found");
      } else if (error.message.includes("NotOwner")) {
        console.error("Error: You don't own this position");
      } else {
        console.error("Error:", error.message);
      }
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Orca Whirlpools Position Management Examples ===");

  // First, fetch positions to get position mints
  const positions = await fetchMyPositions();

  if (positions.length > 0) {
    const positionMint = positions[0].positionMint;

    // Run management examples with the first position
    await increasePositionLiquidity(positionMint);
    await increaseWithTokenB(positionMint);
    await decreasePositionLiquidity(positionMint);
    await withdrawTokenAmount(positionMint);
    await closeMyPosition(positionMint);
    await closePositionSafely(positionMint);
  } else {
    console.log("\nNo positions found. Open a position first!");
  }

  console.log("\n=== Examples Complete ===");
}

main().catch(console.error);
