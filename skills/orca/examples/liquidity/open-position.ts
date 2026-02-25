/**
 * Orca Whirlpools: Open Position Examples
 *
 * This file demonstrates how to open liquidity positions in Orca Whirlpools.
 * Includes concentrated liquidity and full-range position examples.
 */

import {
  openPosition,
  openPositionInstructions,
  openFullRangePosition,
  openFullRangePositionInstructions,
  setWhirlpoolsConfig,
  setRpc,
  setPayerFromBytes,
  fetchConcentratedLiquidityPool,
} from "@orca-so/whirlpools";
import { createSolanaRpc, address, Address } from "@solana/kit";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC endpoint
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Wallet path
  walletPath: process.env.WALLET_PATH || "./keypair.json",

  // Network
  network: "solanaMainnet" as const,

  // Common token mints
  tokens: {
    SOL: address("So11111111111111111111111111111111111111112"),
    USDC: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  },

  // Popular pools
  pools: {
    SOL_USDC: address("7qbRF6YsyGuLUVs6Y1sfC93Vulo2YBcmfkPHJmxRQWYL"),
  },
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

function formatLamports(lamports: bigint): string {
  return formatAmount(lamports, 9) + " SOL";
}

// ============================================================================
// POSITION EXAMPLES
// ============================================================================

/**
 * Example 1: Open a concentrated liquidity position
 *
 * This creates a position with liquidity concentrated in a specific price range.
 * More capital efficient but requires monitoring for out-of-range scenarios.
 */
async function openConcentratedPosition() {
  console.log("\n=== Open Concentrated Liquidity Position ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Fetch pool data to get current price
  const pool = await fetchConcentratedLiquidityPool(rpc, CONFIG.pools.SOL_USDC);
  const currentPrice = pool.price;

  console.log("Pool:", CONFIG.pools.SOL_USDC);
  console.log("Current price:", currentPrice.toFixed(4), "USDC per SOL");

  // Define price range (e.g., +-20% around current price)
  const lowerPrice = currentPrice * 0.8;
  const upperPrice = currentPrice * 1.2;

  console.log("Price range:", lowerPrice.toFixed(4), "-", upperPrice.toFixed(4));

  // Specify liquidity amount (using 0.5 SOL)
  const param = { tokenA: 500_000_000n }; // 0.5 SOL (9 decimals)
  const slippageTolerance = 100; // 1%

  // Get position instructions and quote
  const {
    instructions,
    quote,
    positionMint,
    initializationCost,
  } = await openPositionInstructions(
    rpc,
    CONFIG.pools.SOL_USDC,
    param,
    lowerPrice,
    upperPrice,
    slippageTolerance,
    wallet
  );

  console.log("\nPosition Details:");
  console.log("  Position mint:", positionMint);
  console.log("  Token A (SOL) required:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B (USDC) required:", formatAmount(quote.tokenEstB, 6));
  console.log("  Token A max:", formatAmount(quote.tokenMaxA, 9));
  console.log("  Token B max:", formatAmount(quote.tokenMaxB, 6));
  console.log("  Initialization cost:", formatLamports(initializationCost));
  console.log("  Instructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await openPosition(
  //   rpc, CONFIG.pools.SOL_USDC, param,
  //   lowerPrice, upperPrice, slippageTolerance, wallet
  // );
  // console.log("Transaction:", txId);
}

/**
 * Example 2: Open a full-range position (Splash Pool style)
 *
 * This creates a position covering the entire price range.
 * Simpler to manage but less capital efficient.
 */
async function openFullRange() {
  console.log("\n=== Open Full Range Position ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Specify liquidity amount
  const param = { tokenA: 100_000_000n }; // 0.1 SOL
  const slippageTolerance = 100; // 1%

  // Get position instructions
  const {
    instructions,
    quote,
    positionMint,
    initializationCost,
    callback,
  } = await openFullRangePositionInstructions(
    rpc,
    CONFIG.pools.SOL_USDC,
    param,
    slippageTolerance,
    wallet
  );

  console.log("\nFull Range Position Details:");
  console.log("  Position mint:", positionMint);
  console.log("  Token A (SOL) required:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B (USDC) required:", formatAmount(quote.tokenEstB, 6));
  console.log("  Token A max:", formatAmount(quote.tokenMaxA, 9));
  console.log("  Token B max:", formatAmount(quote.tokenMaxB, 6));
  console.log("  Initialization cost:", formatLamports(initializationCost));

  // Uncomment to execute:
  // const txId = await callback();
  // console.log("Transaction:", txId);
}

/**
 * Example 3: Open position with specific token B amount
 */
async function openPositionWithTokenB() {
  console.log("\n=== Open Position with Token B Amount ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const pool = await fetchConcentratedLiquidityPool(rpc, CONFIG.pools.SOL_USDC);
  const currentPrice = pool.price;

  // Specify using 100 USDC
  const param = { tokenB: 100_000_000n }; // 100 USDC (6 decimals)
  const lowerPrice = currentPrice * 0.9;
  const upperPrice = currentPrice * 1.1;
  const slippageTolerance = 100;

  const { quote, positionMint } = await openPositionInstructions(
    rpc,
    CONFIG.pools.SOL_USDC,
    param,
    lowerPrice,
    upperPrice,
    slippageTolerance,
    wallet
  );

  console.log("\nPosition with Token B:");
  console.log("  Position mint:", positionMint);
  console.log("  Token A (SOL) required:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B (USDC) required:", formatAmount(quote.tokenEstB, 6));
}

/**
 * Example 4: Open position with specific liquidity amount
 */
async function openPositionWithLiquidity() {
  console.log("\n=== Open Position with Liquidity Amount ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const pool = await fetchConcentratedLiquidityPool(rpc, CONFIG.pools.SOL_USDC);
  const currentPrice = pool.price;

  // Specify exact liquidity amount
  const param = { liquidity: 1_000_000_000n };
  const lowerPrice = currentPrice * 0.95;
  const upperPrice = currentPrice * 1.05;
  const slippageTolerance = 100;

  const { quote, positionMint } = await openPositionInstructions(
    rpc,
    CONFIG.pools.SOL_USDC,
    param,
    lowerPrice,
    upperPrice,
    slippageTolerance,
    wallet
  );

  console.log("\nPosition with Liquidity Amount:");
  console.log("  Position mint:", positionMint);
  console.log("  Liquidity:", param.liquidity.toString());
  console.log("  Token A required:", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B required:", formatAmount(quote.tokenEstB, 6));
}

/**
 * Example 5: Open narrow range position for higher fees
 */
async function openNarrowRangePosition() {
  console.log("\n=== Open Narrow Range Position ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const pool = await fetchConcentratedLiquidityPool(rpc, CONFIG.pools.SOL_USDC);
  const currentPrice = pool.price;

  console.log("Current price:", currentPrice.toFixed(4), "USDC per SOL");

  // Very narrow range (+-2%) for maximum capital efficiency
  // Higher fees but more likely to go out of range
  const lowerPrice = currentPrice * 0.98;
  const upperPrice = currentPrice * 1.02;

  console.log("Narrow range:", lowerPrice.toFixed(4), "-", upperPrice.toFixed(4));

  const param = { tokenA: 1_000_000_000n }; // 1 SOL
  const slippageTolerance = 100;

  const { quote, positionMint, initializationCost } = await openPositionInstructions(
    rpc,
    CONFIG.pools.SOL_USDC,
    param,
    lowerPrice,
    upperPrice,
    slippageTolerance,
    wallet
  );

  console.log("\nNarrow Range Position:");
  console.log("  Position mint:", positionMint);
  console.log("  Token A (SOL):", formatAmount(quote.tokenEstA, 9));
  console.log("  Token B (USDC):", formatAmount(quote.tokenEstB, 6));
  console.log("  Init cost:", formatLamports(initializationCost));
  console.log("\nNote: Narrow ranges earn more fees but go out of range faster!");
}

/**
 * Example 6: Open position with error handling
 */
async function openPositionWithErrorHandling() {
  console.log("\n=== Open Position with Error Handling ===");

  try {
    await setWhirlpoolsConfig(CONFIG.network);
    await setRpc(CONFIG.rpcUrl);
    const wallet = await loadWallet();
    const rpc = createSolanaRpc(CONFIG.rpcUrl);

    const pool = await fetchConcentratedLiquidityPool(rpc, CONFIG.pools.SOL_USDC);
    const currentPrice = pool.price;

    const param = { tokenA: 100_000_000n };
    const lowerPrice = currentPrice * 0.9;
    const upperPrice = currentPrice * 1.1;

    const { positionMint } = await openPositionInstructions(
      rpc,
      CONFIG.pools.SOL_USDC,
      param,
      lowerPrice,
      upperPrice,
      100,
      wallet
    );

    console.log("Position ready to open:", positionMint);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("InsufficientFunds")) {
        console.error("Error: Not enough tokens in wallet");
      } else if (error.message.includes("InvalidTickIndex")) {
        console.error("Error: Price range is invalid for this pool");
      } else if (error.message.includes("TickArrayNotInitialized")) {
        console.error("Error: Tick arrays for this range need initialization");
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
  console.log("=== Orca Whirlpools Position Opening Examples ===");

  await openConcentratedPosition();
  await openFullRange();
  await openPositionWithTokenB();
  await openPositionWithLiquidity();
  await openNarrowRangePosition();
  await openPositionWithErrorHandling();

  console.log("\n=== Examples Complete ===");
}

main().catch(console.error);
