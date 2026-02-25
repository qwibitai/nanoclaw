/**
 * Light Protocol - Create Compressed Token Mint
 *
 * This example demonstrates how to create a new token mint
 * with built-in compression support (token pool).
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { createMint } from "@lightprotocol/compressed-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  DECIMALS: 9, // Standard for most tokens
};

// ============================================================================
// Helper Functions
// ============================================================================

function loadKeypairFromEnv(): Keypair {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable not set");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(privateKey)));
}

// ============================================================================
// Create Mint Examples
// ============================================================================

/**
 * Create a basic compressed token mint
 */
async function createBasicMint(
  rpc: Rpc,
  payer: Keypair
): Promise<{ mint: PublicKey; signature: string }> {
  console.log("\n--- Creating Basic Compressed Mint ---");

  const { mint, transactionSignature } = await createMint(
    rpc,
    payer, // Fee payer and mint authority
    payer.publicKey, // Mint authority
    CONFIG.DECIMALS // Decimals
  );

  console.log("Mint Address:", mint.toBase58());
  console.log("Transaction:", transactionSignature);
  console.log("Decimals:", CONFIG.DECIMALS);

  return { mint, signature: transactionSignature };
}

/**
 * Create a mint with a specific keypair (deterministic address)
 */
async function createMintWithKeypair(
  rpc: Rpc,
  payer: Keypair
): Promise<{ mint: PublicKey; signature: string }> {
  console.log("\n--- Creating Mint with Specific Keypair ---");

  // Generate a specific keypair for the mint
  const mintKeypair = Keypair.generate();

  const { mint, transactionSignature } = await createMint(
    rpc,
    payer,
    payer.publicKey,
    CONFIG.DECIMALS,
    mintKeypair // Use specific keypair
  );

  console.log("Mint Address:", mint.toBase58());
  console.log("Expected Address:", mintKeypair.publicKey.toBase58());
  console.log("Match:", mint.equals(mintKeypair.publicKey));
  console.log("Transaction:", transactionSignature);

  return { mint, signature: transactionSignature };
}

/**
 * Create a mint with a freeze authority
 */
async function createMintWithFreezeAuthority(
  rpc: Rpc,
  payer: Keypair,
  freezeAuthority: PublicKey
): Promise<{ mint: PublicKey; signature: string }> {
  console.log("\n--- Creating Mint with Freeze Authority ---");

  const { mint, transactionSignature } = await createMint(
    rpc,
    payer,
    payer.publicKey,
    CONFIG.DECIMALS,
    undefined, // Let SDK generate keypair
    freezeAuthority // Set freeze authority
  );

  console.log("Mint Address:", mint.toBase58());
  console.log("Mint Authority:", payer.publicKey.toBase58());
  console.log("Freeze Authority:", freezeAuthority.toBase58());
  console.log("Transaction:", transactionSignature);

  return { mint, signature: transactionSignature };
}

/**
 * Create a mint with separate mint authority
 */
async function createMintWithSeparateAuthority(
  rpc: Rpc,
  payer: Keypair,
  mintAuthority: PublicKey
): Promise<{ mint: PublicKey; signature: string }> {
  console.log("\n--- Creating Mint with Separate Authority ---");

  const { mint, transactionSignature } = await createMint(
    rpc,
    payer, // Fee payer (different from mint authority)
    mintAuthority, // Mint authority
    CONFIG.DECIMALS
  );

  console.log("Mint Address:", mint.toBase58());
  console.log("Fee Payer:", payer.publicKey.toBase58());
  console.log("Mint Authority:", mintAuthority.toBase58());
  console.log("Transaction:", transactionSignature);

  return { mint, signature: transactionSignature };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Create Compressed Token Mint");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  if (balance < 0.01 * 1e9) {
    console.log("\nInsufficient balance. Need at least 0.01 SOL.");
    console.log(`Run: solana airdrop 1 ${payer.publicKey.toBase58()} --url devnet`);
    return;
  }

  // Example 1: Basic mint
  const { mint: basicMint } = await createBasicMint(rpc, payer);

  // Example 2: Mint with specific keypair (commented out to save SOL)
  // await createMintWithKeypair(rpc, payer);

  // Example 3: Mint with freeze authority
  // const freezeAuthority = Keypair.generate().publicKey;
  // await createMintWithFreezeAuthority(rpc, payer, freezeAuthority);

  // Example 4: Mint with separate authority
  // const mintAuthority = Keypair.generate().publicKey;
  // await createMintWithSeparateAuthority(rpc, payer, mintAuthority);

  console.log("\n" + "=".repeat(60));
  console.log("Mint created successfully!");
  console.log("Save this mint address for minting tokens:", basicMint.toBase58());
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
