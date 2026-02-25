/**
 * Switchboard Read Feed Example
 *
 * This example demonstrates how to read current feed values
 * from Switchboard oracle accounts.
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  PullFeed,
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  network: (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet",

  rpcEndpoint: process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",

  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  // Feed public key to read
  feedPubkey: process.env.FEED_PUBKEY || "",

  // Maximum staleness in slots (1 slot ≈ 400ms)
  maxStalenessSlots: 100,
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function loadWallet(path: string): web3.Keypair {
  const resolvedPath = path.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function getProgramId(network: "mainnet" | "devnet"): web3.PublicKey {
  return network === "mainnet" ? ON_DEMAND_MAINNET_PID : ON_DEMAND_DEVNET_PID;
}

/**
 * Convert scaled value to decimal
 * Switchboard values are typically scaled by 10^18
 */
function toDecimal(scaledValue: bigint, decimals: number = 18): number {
  const divisor = BigInt(10 ** decimals);
  const intPart = scaledValue / divisor;
  const fracPart = scaledValue % divisor;
  return Number(intPart) + Number(fracPart) / Number(divisor);
}

/**
 * Format timestamp
 */
function formatTimestamp(slot: number, slotTime: number = 400): string {
  const nowSlot = Math.floor(Date.now() / slotTime);
  const ageSlots = nowSlot - slot;
  const ageSeconds = (ageSlots * slotTime) / 1000;

  if (ageSeconds < 60) {
    return `${ageSeconds.toFixed(1)}s ago`;
  } else if (ageSeconds < 3600) {
    return `${(ageSeconds / 60).toFixed(1)}m ago`;
  } else {
    return `${(ageSeconds / 3600).toFixed(1)}h ago`;
  }
}

// ============================================================================
// FEED READING OPERATIONS
// ============================================================================

interface FeedState {
  value: bigint;
  decimalValue: number;
  slot: number;
  staleness: number;
  isStale: boolean;
}

/**
 * Read feed state with staleness check
 */
async function readFeedState(
  feedAccount: PullFeed,
  connection: web3.Connection,
  maxStalenessSlots: number
): Promise<FeedState> {
  // Load feed data
  const feedData = await feedAccount.loadData();

  // Get current slot
  const currentSlot = await connection.getSlot();

  // Calculate staleness
  const staleness = currentSlot - feedData.lastUpdatedSlot;
  const isStale = staleness > maxStalenessSlots;

  // Extract value
  const value = BigInt(feedData.value.toString());
  const decimalValue = toDecimal(value);

  return {
    value,
    decimalValue,
    slot: feedData.lastUpdatedSlot,
    staleness,
    isStale,
  };
}

/**
 * Monitor feed with polling
 */
async function monitorFeed(
  feedAccount: PullFeed,
  connection: web3.Connection,
  intervalMs: number = 5000,
  maxIterations: number = 10
): Promise<void> {
  console.log(`\nMonitoring feed (${intervalMs}ms interval)...`);
  console.log("Press Ctrl+C to stop\n");

  let iteration = 0;
  while (iteration < maxIterations) {
    try {
      const state = await readFeedState(
        feedAccount,
        connection,
        CONFIG.maxStalenessSlots
      );

      const staleIndicator = state.isStale ? " [STALE]" : "";
      console.log(
        `[${new Date().toISOString()}] ` +
          `Value: ${state.decimalValue.toFixed(6)} | ` +
          `Slot: ${state.slot} | ` +
          `Staleness: ${state.staleness} slots${staleIndicator}`
      );
    } catch (error: any) {
      console.log(`[${new Date().toISOString()}] Error: ${error.message}`);
    }

    iteration++;
    if (iteration < maxIterations) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  console.log("\nMonitoring complete.");
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Read Feed Example");
  console.log("=".repeat(60));

  // Validate configuration
  if (!CONFIG.feedPubkey) {
    console.error("Error: FEED_PUBKEY environment variable is required");
    console.log("\nUsage:");
    console.log("  FEED_PUBKEY=<your-feed-pubkey> npx ts-node read-feed.ts");
    process.exit(1);
  }

  // Setup
  const wallet = loadWallet(CONFIG.walletPath);
  console.log("\nWallet:", wallet.publicKey.toBase58());

  const connection = new web3.Connection(CONFIG.rpcEndpoint, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {});

  // Load Switchboard program
  const programId = getProgramId(CONFIG.network);
  const sbProgram = await Program.at(programId, provider);
  console.log("Program:", programId.toBase58());

  // Create feed account reference
  const feedPubkey = new web3.PublicKey(CONFIG.feedPubkey);
  const feedAccount = new PullFeed(sbProgram, feedPubkey);
  console.log("Feed:", feedPubkey.toBase58());

  // Read single value
  console.log("\n--- Single Read ---");
  try {
    const state = await readFeedState(
      feedAccount,
      connection,
      CONFIG.maxStalenessSlots
    );

    console.log("\nFeed State:");
    console.log("  Raw value:", state.value.toString());
    console.log("  Decimal value:", state.decimalValue.toFixed(8));
    console.log("  Last updated slot:", state.slot);
    console.log("  Staleness:", state.staleness, "slots");
    console.log("  Is stale:", state.isStale);

    if (state.isStale) {
      console.log(
        "\n⚠️  Warning: Feed is stale! Consider updating before using."
      );
    }
  } catch (error: any) {
    console.error("Error reading feed:", error.message);
    console.log("\nThe feed may not be initialized or may not exist.");
    process.exit(1);
  }

  // Optional: Monitor feed
  const shouldMonitor = process.argv.includes("--monitor");
  if (shouldMonitor) {
    await monitorFeed(feedAccount, connection, 5000, 10);
  } else {
    console.log('\nTip: Add --monitor flag to continuously poll the feed.');
  }

  console.log("\n" + "=".repeat(60));
  console.log("Read complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);
