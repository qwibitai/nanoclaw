/**
 * Light Protocol - Basic Setup Example
 *
 * This example demonstrates how to set up the Light Protocol SDK
 * for interacting with compressed accounts on Solana.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // RPC endpoint (must support ZK Compression - use Helius)
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  // Photon API endpoint (usually same as RPC)
  PHOTON_ENDPOINT: process.env.PHOTON_ENDPOINT || process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  // Path to wallet keypair file
  WALLET_PATH: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Load a Keypair from a JSON file
 */
function loadKeypair(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Load a Keypair from environment variable (base58 or array)
 */
function loadKeypairFromEnv(envVar: string = "PRIVATE_KEY"): Keypair {
  const privateKey = process.env[envVar];
  if (!privateKey) {
    throw new Error(`Environment variable ${envVar} not set`);
  }

  // Try parsing as JSON array first
  try {
    const secretKey = JSON.parse(privateKey);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    // If not JSON, assume base58
    const bs58 = require("bs58");
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  }
}

/**
 * Create RPC connection for Light Protocol
 */
function createLightRpc(): Rpc {
  return createRpc(CONFIG.RPC_ENDPOINT, CONFIG.PHOTON_ENDPOINT);
}

/**
 * Format lamports as SOL
 */
function formatSol(lamports: number | bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

// ============================================================================
// Main Setup Example
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Basic Setup Example");
  console.log("=".repeat(60));

  // Step 1: Create RPC connection
  console.log("\n1. Creating RPC connection...");
  const rpc = createLightRpc();
  console.log("   RPC Endpoint:", CONFIG.RPC_ENDPOINT.split("?")[0] + "?api-key=***");

  // Step 2: Load wallet
  console.log("\n2. Loading wallet...");
  let payer: Keypair;

  try {
    // Try loading from file first
    if (fs.existsSync(CONFIG.WALLET_PATH)) {
      payer = loadKeypair(CONFIG.WALLET_PATH);
      console.log("   Loaded from file:", CONFIG.WALLET_PATH);
    } else if (process.env.PRIVATE_KEY) {
      payer = loadKeypairFromEnv("PRIVATE_KEY");
      console.log("   Loaded from environment variable");
    } else {
      // Generate new keypair for demo
      payer = Keypair.generate();
      console.log("   Generated new keypair (for demo only)");
    }
  } catch (error) {
    console.log("   Error loading wallet, generating new keypair");
    payer = Keypair.generate();
  }

  console.log("   Wallet Address:", payer.publicKey.toBase58());

  // Step 3: Check SOL balance
  console.log("\n3. Checking SOL balance...");
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("   Balance:", formatSol(balance), "SOL");

  if (balance === 0) {
    console.log("   Warning: Wallet has no SOL. Request airdrop on devnet:");
    console.log(`   solana airdrop 1 ${payer.publicKey.toBase58()} --url devnet`);
  }

  // Step 4: Check indexer health
  console.log("\n4. Checking indexer health...");
  try {
    const health = await rpc.getIndexerHealth();
    console.log("   Indexer Status:", health.status || "healthy");
  } catch (error: any) {
    console.log("   Indexer Status: Error -", error.message);
  }

  // Step 5: Get indexer slot
  console.log("\n5. Getting indexer slot...");
  try {
    const indexerSlot = await rpc.getIndexerSlot();
    console.log("   Last Indexed Slot:", indexerSlot.slot);
  } catch (error: any) {
    console.log("   Error getting slot:", error.message);
  }

  // Step 6: Get any existing compressed accounts
  console.log("\n6. Checking for existing compressed accounts...");
  try {
    const compressedAccounts = await rpc.getCompressedAccountsByOwner(payer.publicKey);
    console.log("   Compressed Accounts:", compressedAccounts.items.length);

    if (compressedAccounts.items.length > 0) {
      console.log("   First account hash:", compressedAccounts.items[0].hash);
    }
  } catch (error: any) {
    console.log("   Error fetching accounts:", error.message);
  }

  // Step 7: Get any compressed token accounts
  console.log("\n7. Checking for compressed token accounts...");
  try {
    const tokenAccounts = await rpc.getCompressedTokenAccountsByOwner(payer.publicKey);
    console.log("   Token Accounts:", tokenAccounts.items.length);

    if (tokenAccounts.items.length > 0) {
      for (const account of tokenAccounts.items.slice(0, 3)) {
        console.log(`   - Mint: ${account.parsed.mint.toBase58()}`);
        console.log(`     Balance: ${account.parsed.amount}`);
      }
      if (tokenAccounts.items.length > 3) {
        console.log(`   ... and ${tokenAccounts.items.length - 3} more`);
      }
    }
  } catch (error: any) {
    console.log("   Error fetching token accounts:", error.message);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Setup complete! Ready to use Light Protocol.");
  console.log("=".repeat(60));

  // Return configured objects for further use
  return { rpc, payer };
}

// Run the example
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
