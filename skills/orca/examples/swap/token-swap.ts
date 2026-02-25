/**
 * Orca Whirlpools: Token Swap Examples
 *
 * This file demonstrates how to execute token swaps using the Orca Whirlpools SDK.
 * Includes both exact input and exact output swap examples.
 */

import {
  swap,
  swapInstructions,
  setWhirlpoolsConfig,
  setRpc,
  setPayerFromBytes,
  setPriorityFeeSetting,
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

  // Common token mints (Solana Mainnet)
  tokens: {
    SOL: address("So11111111111111111111111111111111111111112"),
    USDC: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    USDT: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    ORCA: address("orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"),
  },

  // Popular pools
  pools: {
    SOL_USDC: address("7qbRF6YsyGuLUVs6Y1sfC93Vulo2YBcmfkPHJmxRQWYL"),
    USDC_USDT: address("4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4"),
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Load wallet from keypair file
 */
async function loadWallet() {
  const keyPairBytes = new Uint8Array(
    JSON.parse(fs.readFileSync(CONFIG.walletPath, "utf8"))
  );
  return await setPayerFromBytes(keyPairBytes);
}

/**
 * Format token amount for display
 */
function formatAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 4)}`;
}

// ============================================================================
// SWAP EXAMPLES
// ============================================================================

/**
 * Example 1: Simple exact input swap (SOL -> USDC)
 */
async function simpleSwap() {
  console.log("\n=== Simple Exact Input Swap ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();

  console.log("Wallet:", wallet.address);

  // Swap parameters
  const poolAddress = CONFIG.pools.SOL_USDC;
  const inputMint = CONFIG.tokens.SOL;
  const inputAmount = 100_000_000n; // 0.1 SOL (9 decimals)
  const slippageTolerance = 100; // 1%

  console.log("Swapping 0.1 SOL to USDC...");

  // Execute swap
  const txId = await swap(
    createSolanaRpc(CONFIG.rpcUrl),
    { inputAmount, mint: inputMint },
    poolAddress,
    slippageTolerance,
    wallet
  );

  console.log("Transaction:", txId);
}

/**
 * Example 2: Get swap quote and instructions
 */
async function swapWithQuote() {
  console.log("\n=== Swap with Quote ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Swap parameters
  const poolAddress = CONFIG.pools.SOL_USDC;
  const inputMint = CONFIG.tokens.SOL;
  const inputAmount = 1_000_000_000n; // 1 SOL
  const slippageTolerance = 100; // 1%

  // Get swap instructions and quote
  const { instructions, quote } = await swapInstructions(
    rpc,
    { inputAmount, mint: inputMint },
    poolAddress,
    slippageTolerance,
    wallet
  );

  console.log("Swap Quote:");
  console.log("  Input:", formatAmount(quote.tokenEstIn, 9), "SOL");
  console.log("  Expected output:", formatAmount(quote.tokenEstOut, 6), "USDC");
  console.log("  Minimum output:", formatAmount(quote.tokenMinOut, 6), "USDC");
  console.log("  Price impact:", (quote.priceImpact * 100).toFixed(4), "%");
  console.log("  Instructions:", instructions.length);
}

/**
 * Example 3: Exact output swap
 */
async function exactOutputSwap() {
  console.log("\n=== Exact Output Swap ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Swap parameters - get exactly 100 USDC
  const poolAddress = CONFIG.pools.SOL_USDC;
  const outputMint = CONFIG.tokens.USDC;
  const outputAmount = 100_000_000n; // 100 USDC (6 decimals)
  const slippageTolerance = 100; // 1%

  // Get swap instructions
  const { instructions, quote } = await swapInstructions(
    rpc,
    { outputAmount, mint: outputMint },
    poolAddress,
    slippageTolerance,
    wallet
  );

  console.log("Exact Output Swap Quote:");
  console.log("  Desired output:", formatAmount(outputAmount, 6), "USDC");
  console.log("  Estimated input:", formatAmount(quote.tokenEstIn, 9), "SOL");
  console.log("  Maximum input:", formatAmount(quote.tokenMaxIn, 9), "SOL");
  console.log("  Price impact:", (quote.priceImpact * 100).toFixed(4), "%");
}

/**
 * Example 4: Swap with priority fees
 */
async function swapWithPriorityFees() {
  console.log("\n=== Swap with Priority Fees ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();

  // Configure priority fees
  await setPriorityFeeSetting({
    type: "dynamic",
    percentile: 75, // Use 75th percentile of recent fees
  });

  console.log("Priority fees configured (dynamic, 75th percentile)");

  // Swap parameters
  const poolAddress = CONFIG.pools.SOL_USDC;
  const inputMint = CONFIG.tokens.SOL;
  const inputAmount = 100_000_000n; // 0.1 SOL
  const slippageTolerance = 100;

  // Execute swap with priority fees
  const txId = await swap(
    createSolanaRpc(CONFIG.rpcUrl),
    { inputAmount, mint: inputMint },
    poolAddress,
    slippageTolerance,
    wallet
  );

  console.log("Transaction (with priority fees):", txId);
}

/**
 * Example 5: Stablecoin swap (USDC -> USDT)
 */
async function stablecoinSwap() {
  console.log("\n=== Stablecoin Swap (USDC -> USDT) ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Swap parameters - stablecoin pools have lower slippage
  const poolAddress = CONFIG.pools.USDC_USDT;
  const inputMint = CONFIG.tokens.USDC;
  const inputAmount = 100_000_000n; // 100 USDC
  const slippageTolerance = 10; // 0.1% (tighter for stablecoins)

  // Get swap quote
  const { quote } = await swapInstructions(
    rpc,
    { inputAmount, mint: inputMint },
    poolAddress,
    slippageTolerance,
    wallet
  );

  console.log("Stablecoin Swap Quote:");
  console.log("  Input:", formatAmount(quote.tokenEstIn, 6), "USDC");
  console.log("  Expected output:", formatAmount(quote.tokenEstOut, 6), "USDT");
  console.log("  Price impact:", (quote.priceImpact * 100).toFixed(6), "%");
}

/**
 * Example 6: Swap with custom transaction building
 */
async function swapWithCustomTx() {
  console.log("\n=== Swap with Custom Transaction ===");

  // Setup
  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  // Get swap instructions
  const { instructions, quote, callback } = await swapInstructions(
    rpc,
    { inputAmount: 100_000_000n, mint: CONFIG.tokens.SOL },
    CONFIG.pools.SOL_USDC,
    100,
    wallet
  );

  console.log("Got", instructions.length, "instructions");
  console.log("Expected output:", formatAmount(quote.tokenEstOut, 6), "USDC");

  // Option 1: Use the callback to send
  // const txId = await callback();

  // Option 2: Build custom transaction with instructions
  // You can add these instructions to your own transaction builder
  console.log("Instructions ready for custom transaction building");
}

// ============================================================================
// ERROR HANDLING EXAMPLE
// ============================================================================

/**
 * Example: Swap with error handling
 */
async function swapWithErrorHandling() {
  console.log("\n=== Swap with Error Handling ===");

  try {
    await setWhirlpoolsConfig(CONFIG.network);
    await setRpc(CONFIG.rpcUrl);
    const wallet = await loadWallet();

    const txId = await swap(
      createSolanaRpc(CONFIG.rpcUrl),
      { inputAmount: 100_000_000n, mint: CONFIG.tokens.SOL },
      CONFIG.pools.SOL_USDC,
      100,
      wallet
    );

    console.log("Swap successful:", txId);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("SlippageExceeded")) {
        console.error("Error: Slippage tolerance exceeded");
        console.error("Try increasing slippage or reducing swap amount");
      } else if (error.message.includes("InsufficientFunds")) {
        console.error("Error: Insufficient token balance");
      } else if (error.message.includes("ZeroTradableAmount")) {
        console.error("Error: Swap amount too small");
      } else {
        console.error("Swap failed:", error.message);
      }
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Orca Whirlpools Swap Examples ===");

  // Run examples (comment/uncomment as needed)
  await swapWithQuote();
  await exactOutputSwap();
  await stablecoinSwap();
  await swapWithCustomTx();

  // These examples execute actual transactions:
  // await simpleSwap();
  // await swapWithPriorityFees();
  // await swapWithErrorHandling();

  console.log("\n=== Examples Complete ===");
}

main().catch(console.error);
