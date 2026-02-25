/**
 * Orca Whirlpools: Pool Creation Examples
 *
 * This file demonstrates how to create new liquidity pools on Orca.
 * Includes splash pools and concentrated liquidity pools.
 */

import {
  createSplashPool,
  createSplashPoolInstructions,
  createConcentratedLiquidityPool,
  createConcentratedLiquidityPoolInstructions,
  fetchWhirlpoolsByTokenPair,
  setWhirlpoolsConfig,
  setRpc,
  setPayerFromBytes,
  orderMints,
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

  // Common token mints
  tokens: {
    SOL: address("So11111111111111111111111111111111111111112"),
    USDC: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    USDT: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
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

function formatLamports(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6) + " SOL";
}

// ============================================================================
// CHECK EXISTING POOLS
// ============================================================================

/**
 * Example 1: Check if pools already exist for a token pair
 */
async function checkExistingPools(tokenMintA: Address, tokenMintB: Address) {
  console.log("\n=== Check Existing Pools ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Order mints according to Whirlpool conventions
  const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);

  console.log("Token A:", orderedA);
  console.log("Token B:", orderedB);

  const pools = await fetchWhirlpoolsByTokenPair(rpc, orderedA, orderedB);

  console.log("\nExisting pools:", pools.length);

  for (const pool of pools) {
    console.log("\nPool:", pool.address);
    console.log("  Tick spacing:", pool.tickSpacing);
    console.log("  Fee rate:", (pool.feeRate / 10000).toFixed(2) + "%");
    console.log("  Liquidity:", pool.liquidity.toString());
  }

  return pools;
}

// ============================================================================
// CREATE SPLASH POOL
// ============================================================================

/**
 * Example 2: Create a splash pool (full-range, simple)
 *
 * Splash pools are simpler pools with full-range liquidity.
 * Good for tokens that don't need concentrated liquidity.
 */
async function createNewSplashPool(
  tokenMintA: Address,
  tokenMintB: Address,
  initialPrice: number
) {
  console.log("\n=== Create Splash Pool ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Order mints
  const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);

  console.log("Creating splash pool:");
  console.log("  Token A:", orderedA);
  console.log("  Token B:", orderedB);
  console.log("  Initial price:", initialPrice, "(B per A)");

  // Get pool creation instructions
  const {
    instructions,
    poolAddress,
    initializationCost,
    callback,
  } = await createSplashPoolInstructions(
    rpc,
    orderedA,
    orderedB,
    initialPrice,
    wallet
  );

  console.log("\nPool Details:");
  console.log("  Pool address:", poolAddress);
  console.log("  Initialization cost:", formatLamports(initializationCost));
  console.log("  Instructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await callback();
  // console.log("\nPool created:", txId);

  return poolAddress;
}

// ============================================================================
// CREATE CONCENTRATED LIQUIDITY POOL
// ============================================================================

/**
 * Example 3: Create a concentrated liquidity pool
 *
 * These pools allow liquidity providers to concentrate liquidity
 * in specific price ranges for higher capital efficiency.
 */
async function createNewConcentratedPool(
  tokenMintA: Address,
  tokenMintB: Address,
  tickSpacing: number,
  initialPrice: number
) {
  console.log("\n=== Create Concentrated Liquidity Pool ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Order mints
  const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);

  console.log("Creating concentrated liquidity pool:");
  console.log("  Token A:", orderedA);
  console.log("  Token B:", orderedB);
  console.log("  Tick spacing:", tickSpacing);
  console.log("  Initial price:", initialPrice);

  // Get pool creation instructions
  const {
    instructions,
    poolAddress,
    initializationCost,
    callback,
  } = await createConcentratedLiquidityPoolInstructions(
    rpc,
    orderedA,
    orderedB,
    tickSpacing,
    initialPrice,
    wallet
  );

  console.log("\nPool Details:");
  console.log("  Pool address:", poolAddress);
  console.log("  Initialization cost:", formatLamports(initializationCost));
  console.log("  Instructions:", instructions.length);

  // Uncomment to execute:
  // const txId = await callback();
  // console.log("\nPool created:", txId);

  return poolAddress;
}

/**
 * Example 4: Create pool with specific tick spacing for use case
 */
async function createPoolForUseCase(
  tokenMintA: Address,
  tokenMintB: Address,
  useCase: "stablecoin" | "correlated" | "standard" | "volatile",
  initialPrice: number
) {
  console.log("\n=== Create Pool for Use Case:", useCase, "===");

  // Select tick spacing based on use case
  const tickSpacingMap = {
    stablecoin: 1, // 0.01% fee, tight ranges for stables
    correlated: 8, // 0.04% fee, correlated assets
    standard: 64, // 0.30% fee, standard pairs
    volatile: 128, // 1.00% fee, volatile/exotic pairs
  };

  const tickSpacing = tickSpacingMap[useCase];
  console.log("Selected tick spacing:", tickSpacing);

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);

  const { poolAddress, initializationCost } =
    await createConcentratedLiquidityPoolInstructions(
      rpc,
      orderedA,
      orderedB,
      tickSpacing,
      initialPrice,
      wallet
    );

  console.log("Pool address:", poolAddress);
  console.log("Cost:", formatLamports(initializationCost));

  return poolAddress;
}

/**
 * Example 5: Create pool with error handling
 */
async function createPoolWithErrorHandling(
  tokenMintA: Address,
  tokenMintB: Address,
  tickSpacing: number,
  initialPrice: number
) {
  console.log("\n=== Create Pool with Error Handling ===");

  try {
    await setWhirlpoolsConfig(CONFIG.network);
    await setRpc(CONFIG.rpcUrl);
    const wallet = await loadWallet();
    const rpc = createSolanaRpc(CONFIG.rpcUrl);

    // First check if pool already exists
    const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);
    const existingPools = await fetchWhirlpoolsByTokenPair(rpc, orderedA, orderedB);

    const existingWithSameSpacing = existingPools.find(
      (p) => p.tickSpacing === tickSpacing
    );

    if (existingWithSameSpacing) {
      console.log("Pool already exists:", existingWithSameSpacing.address);
      return existingWithSameSpacing.address;
    }

    // Create new pool
    const { poolAddress, initializationCost, callback } =
      await createConcentratedLiquidityPoolInstructions(
        rpc,
        orderedA,
        orderedB,
        tickSpacing,
        initialPrice,
        wallet
      );

    console.log("Ready to create pool:", poolAddress);
    console.log("Cost:", formatLamports(initializationCost));

    // Uncomment to execute:
    // const txId = await callback();
    // console.log("Created:", txId);

    return poolAddress;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("InvalidTickSpacing")) {
        console.error("Error: Invalid tick spacing. Use 1, 8, 64, or 128");
      } else if (error.message.includes("InvalidTokenMintOrder")) {
        console.error("Error: Token mints must be ordered. Use orderMints()");
      } else if (error.message.includes("PoolAlreadyExists")) {
        console.error("Error: Pool with this configuration already exists");
      } else if (error.message.includes("InsufficientFunds")) {
        console.error("Error: Not enough SOL for initialization");
      } else {
        console.error("Error:", error.message);
      }
    }
    return null;
  }
}

/**
 * Example 6: Calculate pool creation costs
 */
async function calculatePoolCosts() {
  console.log("\n=== Calculate Pool Creation Costs ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const tokenA = CONFIG.tokens.SOL;
  const tokenB = CONFIG.tokens.USDC;
  const [orderedA, orderedB] = orderMints(tokenA, tokenB);

  console.log("Comparing pool creation costs:\n");

  // Splash pool cost
  const splashResult = await createSplashPoolInstructions(
    rpc,
    orderedA,
    orderedB,
    100, // $100 per SOL
    wallet
  );
  console.log("Splash Pool:");
  console.log("  Cost:", formatLamports(splashResult.initializationCost));

  // Different tick spacing costs
  for (const tickSpacing of [1, 8, 64, 128]) {
    try {
      const result = await createConcentratedLiquidityPoolInstructions(
        rpc,
        orderedA,
        orderedB,
        tickSpacing,
        100,
        wallet
      );
      console.log(`\nConcentrated (tick spacing ${tickSpacing}):`);
      console.log("  Cost:", formatLamports(result.initializationCost));
    } catch {
      console.log(`\nConcentrated (tick spacing ${tickSpacing}): Already exists`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Orca Whirlpools Pool Creation Examples ===");

  // Check existing pools
  await checkExistingPools(CONFIG.tokens.SOL, CONFIG.tokens.USDC);

  // These examples show how to create pools (don't execute without proper tokens)
  // await createNewSplashPool(tokenA, tokenB, 100);
  // await createNewConcentratedPool(tokenA, tokenB, 64, 100);
  // await createPoolForUseCase(tokenA, tokenB, "standard", 100);
  // await createPoolWithErrorHandling(tokenA, tokenB, 64, 100);

  // Calculate costs for reference
  await calculatePoolCosts();

  console.log("\n=== Examples Complete ===");
}

main().catch(console.error);
