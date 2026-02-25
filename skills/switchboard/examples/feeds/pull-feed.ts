/**
 * Switchboard Pull Feed Example
 *
 * This example demonstrates how to fetch and update oracle feed data
 * using the traditional pull-based approach.
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  PullFeed,
  CrossbarClient,
  asV0Tx,
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  network: (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet",

  rpcEndpoint:
    process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",

  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  crossbarEndpoint: "https://crossbar.switchboard.xyz",

  // Your feed public key (replace with actual feed)
  feedPubkey: process.env.FEED_PUBKEY || "",

  // Transaction settings
  computeUnitPrice: 200_000, // Priority fee in microlamports
  computeUnitLimitMultiple: 1.3,
  numSignatures: 3, // Number of oracle signatures to request
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

// ============================================================================
// PULL FEED OPERATIONS
// ============================================================================

/**
 * Fetch update instruction from oracles
 */
async function fetchFeedUpdate(
  feedAccount: PullFeed,
  crossbar: CrossbarClient,
  network: "mainnet" | "devnet"
) {
  console.log("\nFetching oracle signatures...");

  const { pullIx, responses, numSuccess, luts } =
    await feedAccount.fetchUpdateIx({
      crossbarClient: crossbar,
      chain: "solana",
      network,
      numSignatures: CONFIG.numSignatures,
    });

  console.log(`Received ${numSuccess} oracle responses`);

  if (numSuccess < 1) {
    throw new Error("No oracle responses received");
  }

  return { pullIx, responses, numSuccess, luts };
}

/**
 * Build and send update transaction
 */
async function sendUpdateTransaction(
  connection: web3.Connection,
  pullIx: web3.TransactionInstruction,
  luts: web3.AddressLookupTableAccount[],
  payer: web3.Keypair
): Promise<string> {
  console.log("\nBuilding transaction...");

  const tx = await asV0Tx({
    connection,
    ixs: [pullIx],
    signers: [payer],
    computeUnitPrice: CONFIG.computeUnitPrice,
    computeUnitLimitMultiple: CONFIG.computeUnitLimitMultiple,
    lookupTables: luts,
  });

  console.log("Sending transaction...");
  const signature = await connection.sendTransaction(tx);

  console.log("Confirming transaction...");
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

/**
 * Read current feed value
 */
async function readFeedValue(feedAccount: PullFeed): Promise<{
  value: bigint;
  slot: number;
}> {
  const feedData = await feedAccount.loadData();

  return {
    value: BigInt(feedData.value.toString()),
    slot: feedData.lastUpdatedSlot,
  };
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Pull Feed Example");
  console.log("=".repeat(60));

  // Validate configuration
  if (!CONFIG.feedPubkey) {
    console.error("Error: FEED_PUBKEY environment variable is required");
    console.log("\nUsage:");
    console.log("  FEED_PUBKEY=<your-feed-pubkey> npx ts-node pull-feed.ts");
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

  // Initialize Crossbar client
  const crossbar = new CrossbarClient(CONFIG.crossbarEndpoint);

  // Create feed account reference
  const feedPubkey = new web3.PublicKey(CONFIG.feedPubkey);
  const feedAccount = new PullFeed(sbProgram, feedPubkey);
  console.log("Feed:", feedPubkey.toBase58());

  // Read current value (before update)
  console.log("\n--- Current Feed State ---");
  try {
    const { value, slot } = await readFeedValue(feedAccount);
    console.log("Value:", value.toString());
    console.log("Last updated slot:", slot);
  } catch (error) {
    console.log("Feed not yet initialized or empty");
  }

  // Fetch and send update
  console.log("\n--- Updating Feed ---");
  const { pullIx, numSuccess, luts } = await fetchFeedUpdate(
    feedAccount,
    crossbar,
    CONFIG.network
  );
  console.log("Oracle responses:", numSuccess);

  const signature = await sendUpdateTransaction(
    connection,
    pullIx,
    luts,
    wallet
  );
  console.log("Transaction signature:", signature);

  // Read updated value
  console.log("\n--- Updated Feed State ---");
  const { value: newValue, slot: newSlot } = await readFeedValue(feedAccount);
  console.log("Value:", newValue.toString());
  console.log("Updated slot:", newSlot);

  console.log("\n" + "=".repeat(60));
  console.log("Feed update complete!");
  console.log("=".repeat(60));
}

main().catch(console.error);
