/**
 * Orca Whirlpools: Harvest Fees Examples
 *
 * This file demonstrates how to collect fees and rewards from liquidity positions.
 */

import {
  harvestPosition,
  harvestPositionInstructions,
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
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 6)}`;
}

// ============================================================================
// HARVEST EXAMPLES
// ============================================================================

/**
 * Example 1: Check fees and rewards for all positions
 */
async function checkAllPositionFees() {
  console.log("\n=== Check All Position Fees ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const positions = await fetchPositionsForOwner(rpc, wallet.address);

  console.log("Found", positions.length, "positions\n");

  let totalFeeA = 0n;
  let totalFeeB = 0n;

  for (const position of positions) {
    console.log("Position:", position.positionMint.slice(0, 8) + "...");
    console.log("  Fee owed A:", formatAmount(position.feeOwedA, 9));
    console.log("  Fee owed B:", formatAmount(position.feeOwedB, 6));

    if (position.rewardInfos && position.rewardInfos.length > 0) {
      console.log("  Rewards:");
      for (let i = 0; i < position.rewardInfos.length; i++) {
        const reward = position.rewardInfos[i];
        if (reward && reward.amountOwed > 0n) {
          console.log(`    Reward ${i}:`, reward.amountOwed.toString());
        }
      }
    }

    totalFeeA += position.feeOwedA;
    totalFeeB += position.feeOwedB;
    console.log("");
  }

  console.log("=== Total Uncollected Fees ===");
  console.log("  Token A:", formatAmount(totalFeeA, 9));
  console.log("  Token B:", formatAmount(totalFeeB, 6));

  return positions;
}

/**
 * Example 2: Harvest fees from a single position
 */
async function harvestSinglePosition(positionMint: Address) {
  console.log("\n=== Harvest Single Position ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const {
    instructions,
    feesQuote,
    rewardsQuote,
    callback,
  } = await harvestPositionInstructions(rpc, positionMint, wallet);

  console.log("Position:", positionMint);
  console.log("\nFees to collect:");
  console.log("  Token A:", formatAmount(feesQuote.feeOwedA, 9));
  console.log("  Token B:", formatAmount(feesQuote.feeOwedB, 6));

  if (rewardsQuote && rewardsQuote.length > 0) {
    console.log("\nRewards to collect:");
    for (let i = 0; i < rewardsQuote.length; i++) {
      const reward = rewardsQuote[i];
      if (reward && reward.amountOwed > 0n) {
        console.log(`  Reward ${i}:`, reward.amountOwed.toString());
      }
    }
  }

  console.log("\nInstructions:", instructions.length);

  // Check if there's anything to harvest
  const hasFees = feesQuote.feeOwedA > 0n || feesQuote.feeOwedB > 0n;
  const hasRewards = rewardsQuote?.some((r) => r && r.amountOwed > 0n);

  if (!hasFees && !hasRewards) {
    console.log("\nNo fees or rewards to collect!");
    return null;
  }

  // Uncomment to execute:
  // const txId = await callback();
  // console.log("\nHarvested! Transaction:", txId);

  return { feesQuote, rewardsQuote };
}

/**
 * Example 3: Harvest all positions
 */
async function harvestAllPositions() {
  console.log("\n=== Harvest All Positions ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const positions = await fetchPositionsForOwner(rpc, wallet.address);

  console.log("Found", positions.length, "positions");

  let harvestedCount = 0;

  for (const position of positions) {
    const hasFees = position.feeOwedA > 0n || position.feeOwedB > 0n;

    if (hasFees) {
      console.log("\nHarvesting position:", position.positionMint.slice(0, 8) + "...");
      console.log("  Fees: ", formatAmount(position.feeOwedA, 9), "/", formatAmount(position.feeOwedB, 6));

      // Get harvest instructions
      const { callback } = await harvestPositionInstructions(
        rpc,
        position.positionMint,
        wallet
      );

      // Uncomment to execute:
      // const txId = await callback();
      // console.log("  Harvested:", txId);

      harvestedCount++;
    }
  }

  console.log("\nPositions with fees:", harvestedCount);
}

/**
 * Example 4: Harvest with minimum threshold
 */
async function harvestWithThreshold(minValueUSD: number) {
  console.log("\n=== Harvest with Minimum Threshold ===");
  console.log("Minimum value:", minValueUSD, "USD");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const positions = await fetchPositionsForOwner(rpc, wallet.address);

  // Assume rough prices for example (in production, fetch from oracle)
  const SOL_PRICE = 100; // USD
  const TOKEN_B_PRICE = 1; // USDC

  for (const position of positions) {
    // Calculate approximate USD value of fees
    const feeAValue = (Number(position.feeOwedA) / 1e9) * SOL_PRICE;
    const feeBValue = Number(position.feeOwedB) / 1e6 * TOKEN_B_PRICE;
    const totalValue = feeAValue + feeBValue;

    console.log("\nPosition:", position.positionMint.slice(0, 8) + "...");
    console.log("  Fee value: $", totalValue.toFixed(2));

    if (totalValue >= minValueUSD) {
      console.log("  -> Worth harvesting!");

      // Uncomment to execute:
      // const { callback } = await harvestPositionInstructions(rpc, position.positionMint, wallet);
      // const txId = await callback();
      // console.log("  Harvested:", txId);
    } else {
      console.log("  -> Below threshold, skipping");
    }
  }
}

/**
 * Example 5: Harvest with error handling
 */
async function harvestWithErrorHandling(positionMint: Address) {
  console.log("\n=== Harvest with Error Handling ===");

  try {
    await setWhirlpoolsConfig(CONFIG.network);
    await setRpc(CONFIG.rpcUrl);
    const wallet = await loadWallet();
    const rpc = createSolanaRpc(CONFIG.rpcUrl);

    const { feesQuote, callback } = await harvestPositionInstructions(
      rpc,
      positionMint,
      wallet
    );

    console.log("Ready to harvest:");
    console.log("  Token A:", formatAmount(feesQuote.feeOwedA, 9));
    console.log("  Token B:", formatAmount(feesQuote.feeOwedB, 6));

    // Uncomment to execute:
    // const txId = await callback();
    // console.log("Harvested:", txId);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("PositionNotFound")) {
        console.error("Error: Position does not exist");
      } else if (error.message.includes("NotOwner")) {
        console.error("Error: You don't own this position");
      } else if (error.message.includes("NoFees")) {
        console.error("Error: No fees to collect");
      } else {
        console.error("Error:", error.message);
      }
    }
  }
}

/**
 * Example 6: Calculate APY from fees
 */
async function calculatePositionAPY(positionMint: Address) {
  console.log("\n=== Calculate Position APY ===");

  await setWhirlpoolsConfig(CONFIG.network);
  await setRpc(CONFIG.rpcUrl);
  const wallet = await loadWallet();
  const rpc = createSolanaRpc(CONFIG.rpcUrl);

  const positions = await fetchPositionsForOwner(rpc, wallet.address);
  const position = positions.find((p) => p.positionMint === positionMint);

  if (!position) {
    console.log("Position not found");
    return;
  }

  console.log("Position:", positionMint.slice(0, 8) + "...");
  console.log("Liquidity:", position.liquidity.toString());
  console.log("Current fees:");
  console.log("  Token A:", formatAmount(position.feeOwedA, 9));
  console.log("  Token B:", formatAmount(position.feeOwedB, 6));

  // Note: To calculate actual APY, you would need:
  // 1. Position age (when it was opened)
  // 2. Historical fee collection data
  // 3. Current token prices
  // 4. Total value locked in position

  console.log("\nNote: For accurate APY calculation, track fees over time");
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Orca Whirlpools Harvest Fees Examples ===");

  // Check all positions first
  const positions = await checkAllPositionFees();

  if (positions.length > 0) {
    const positionMint = positions[0].positionMint;

    // Run harvest examples
    await harvestSinglePosition(positionMint);
    await harvestAllPositions();
    await harvestWithThreshold(5); // $5 minimum
    await harvestWithErrorHandling(positionMint);
    await calculatePositionAPY(positionMint);
  } else {
    console.log("\nNo positions found. Open a position first!");
  }

  console.log("\n=== Examples Complete ===");
}

main().catch(console.error);
