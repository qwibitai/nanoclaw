/**
 * Switchboard Oracle Quote Example
 *
 * This example demonstrates the recommended Oracle Quote approach
 * for consuming oracle data with sub-second latency and 90% lower costs.
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  OracleQuote,
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

  rpcEndpoint: process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",

  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  crossbarEndpoint: "https://crossbar.switchboard.xyz",

  // Feed hashes (64-character hex strings)
  // Replace with your actual feed hashes from the Feed Builder
  feedHashes: process.env.FEED_HASHES?.split(",") || [
    // Example: SOL/USD feed hash (replace with actual)
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  ],

  // Queue addresses
  queues: {
    mainnet: new web3.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"),
    devnet: new web3.PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"),
  },

  // Transaction settings
  numSignatures: 1,
  computeUnitPrice: 200_000,
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

function getQueue(network: "mainnet" | "devnet"): web3.PublicKey {
  return CONFIG.queues[network];
}

/**
 * Validate feed hash format
 */
function validateFeedHash(hash: string): boolean {
  // Remove 0x prefix if present
  const cleanHash = hash.startsWith("0x") ? hash.slice(2) : hash;
  // Should be 64 hex characters
  return /^[0-9a-fA-F]{64}$/.test(cleanHash);
}

// ============================================================================
// ORACLE QUOTE OPERATIONS
// ============================================================================

/**
 * Derive canonical quote account address
 */
function deriveQuoteAccount(
  queueKey: web3.PublicKey,
  feedHashes: string[],
  programId?: web3.PublicKey
): web3.PublicKey {
  return OracleQuote.getCanonicalPubkey(queueKey, feedHashes, programId);
}

/**
 * Fetch quote instruction from oracles
 */
async function fetchQuoteInstruction(
  crossbar: CrossbarClient,
  queueKey: web3.PublicKey,
  feedHashes: string[]
): Promise<web3.TransactionInstruction> {
  console.log("\nFetching quote from oracles...");

  // This would typically be called through the queue account
  // For demonstration, we show the pattern
  const sigVerifyIx = await (queueKey as any).fetchQuoteIx(crossbar, feedHashes, {
    numSignatures: CONFIG.numSignatures,
    variableOverrides: {},
  });

  return sigVerifyIx;
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Oracle Quote Example");
  console.log("=".repeat(60));

  // Validate feed hashes
  const validHashes = CONFIG.feedHashes.filter(validateFeedHash);
  if (validHashes.length === 0) {
    console.error("Error: No valid feed hashes provided");
    console.log("\nUsage:");
    console.log('  FEED_HASHES="0x...,0x..." npx ts-node oracle-quote.ts');
    console.log("\nFeed hashes should be 64-character hex strings");
    process.exit(1);
  }

  console.log("\nFeed hashes to query:");
  validHashes.forEach((hash, i) => {
    console.log(`  ${i + 1}. ${hash.slice(0, 20)}...${hash.slice(-8)}`);
  });

  // Setup
  const wallet = loadWallet(CONFIG.walletPath);
  console.log("\nWallet:", wallet.publicKey.toBase58());

  const connection = new web3.Connection(CONFIG.rpcEndpoint, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {});

  // Load Switchboard program
  const programId = getProgramId(CONFIG.network);
  const sbProgram = await Program.at(programId, provider);
  console.log("Program:", programId.toBase58());

  // Get queue
  const queueKey = getQueue(CONFIG.network);
  console.log("Queue:", queueKey.toBase58());

  // Derive canonical quote account
  const quotePubkey = deriveQuoteAccount(queueKey, validHashes);
  console.log("\nCanonical quote account:", quotePubkey.toBase58());

  // Initialize Crossbar client
  const crossbar = new CrossbarClient(CONFIG.crossbarEndpoint);

  console.log("\n--- Oracle Quote Integration Pattern ---");
  console.log(`
The Oracle Quote approach is the recommended way to consume
Switchboard oracle data. It provides:

1. Sub-second latency
2. 90% cost reduction vs traditional feeds
3. No write locks (parallel reads possible)
4. Stateless design (prices not stored on-chain)

Integration steps:
1. Create feed in Feed Builder (ondemand.switchboard.xyz)
2. Get feed hash (64-char hex string)
3. Derive canonical quote account
4. Fetch quote instruction from oracles
5. Include secp256k1 verification in your transaction
6. Read verified data in your program

Example Rust integration:

\`\`\`rust
use switchboard_on_demand::{default_queue, SwitchboardQuote};

#[derive(Accounts)]
pub struct ReadQuote<'info> {
    #[account(address = quote_account.canonical_key(&default_queue()))]
    pub quote_account: Box<Account<'info, SwitchboardQuote>>,
}
\`\`\`
`);

  console.log("=".repeat(60));
  console.log("See the Rust reference for complete integration code.");
  console.log("=".repeat(60));
}

main().catch(console.error);
