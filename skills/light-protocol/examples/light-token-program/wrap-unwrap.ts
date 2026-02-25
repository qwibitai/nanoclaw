/**
 * Light Token Program - Wrap and Unwrap
 *
 * This example demonstrates how to wrap SPL tokens into Light tokens
 * and unwrap Light tokens back to SPL format.
 *
 * This enables seamless interoperability between the two token standards.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  DECIMALS: 9,
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

function formatTokenAmount(amount: bigint | number, decimals: number): string {
  return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

// ============================================================================
// Wrap/Unwrap Examples
// ============================================================================

/**
 * Wrap SPL tokens to Light tokens
 *
 * This converts regular SPL tokens into Light tokens,
 * which can then be used with the Light Token Program.
 */
async function wrapSplToLight(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  amount: number,
  owner: Keypair,
  splTokenAccount: PublicKey
): Promise<string> {
  console.log("\n--- Wrap SPL to Light Tokens ---");
  console.log("Mint:", mint.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");
  console.log("SPL Token Account:", splTokenAccount.toBase58());

  /**
   * Using the Light Token SDK:
   *
   * import { wrapSpl } from "@lightprotocol/light-token";
   *
   * const transactionSignature = await wrapSpl(
   *   rpc,
   *   payer,
   *   mint,
   *   amount,
   *   owner,
   *   splTokenAccount
   * );
   */

  console.log("\nExpected usage:");
  console.log(`
  import { wrapSpl } from "@lightprotocol/light-token";

  const signature = await wrapSpl(
    rpc,
    payer,           // Fee payer
    mint,            // SPL mint address
    ${amount},       // Amount to wrap
    owner,           // SPL token owner (signer)
    splTokenAccount  // Source SPL token account
  );
  `);

  console.log("\nAfter wrapping:");
  console.log("- SPL token balance decreases by", formatTokenAmount(amount, CONFIG.DECIMALS));
  console.log("- Light token balance increases by", formatTokenAmount(amount, CONFIG.DECIMALS));

  return "placeholder_signature";
}

/**
 * Unwrap Light tokens to SPL tokens
 *
 * This converts Light tokens back to regular SPL tokens.
 */
async function unwrapLightToSpl(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  amount: number,
  owner: Keypair,
  splTokenAccount: PublicKey
): Promise<string> {
  console.log("\n--- Unwrap Light to SPL Tokens ---");
  console.log("Mint:", mint.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");
  console.log("Destination SPL Account:", splTokenAccount.toBase58());

  /**
   * Using the Light Token SDK:
   *
   * import { unwrapToSpl } from "@lightprotocol/light-token";
   *
   * const transactionSignature = await unwrapToSpl(
   *   rpc,
   *   payer,
   *   mint,
   *   amount,
   *   owner,
   *   splTokenAccount
   * );
   */

  console.log("\nExpected usage:");
  console.log(`
  import { unwrapToSpl } from "@lightprotocol/light-token";

  const signature = await unwrapToSpl(
    rpc,
    payer,           // Fee payer
    mint,            // Token mint address
    ${amount},       // Amount to unwrap
    owner,           // Light token owner (signer)
    splTokenAccount  // Destination SPL token account
  );
  `);

  console.log("\nAfter unwrapping:");
  console.log("- Light token balance decreases by", formatTokenAmount(amount, CONFIG.DECIMALS));
  console.log("- SPL token balance increases by", formatTokenAmount(amount, CONFIG.DECIMALS));

  return "placeholder_signature";
}

/**
 * Wrap Token-2022 tokens to Light tokens
 *
 * Light Token Program also supports Token-2022 (Token Extensions).
 */
async function wrapToken2022(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  amount: number,
  owner: Keypair,
  token2022Account: PublicKey
): Promise<string> {
  console.log("\n--- Wrap Token-2022 to Light Tokens ---");
  console.log("Mint:", mint.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");
  console.log("Token-2022 Account:", token2022Account.toBase58());

  console.log("\nExpected usage:");
  console.log(`
  import { wrapToken2022 } from "@lightprotocol/light-token";

  const signature = await wrapToken2022(
    rpc,
    payer,
    mint,            // Token-2022 mint
    ${amount},
    owner,
    token2022Account // Source Token-2022 account
  );
  `);

  console.log("\nToken-2022 extensions supported:");
  console.log("- Transfer fees");
  console.log("- Interest-bearing tokens");
  console.log("- Non-transferable tokens");
  console.log("- Permanent delegate");
  console.log("- And more...");

  return "placeholder_signature";
}

/**
 * Check balances across formats
 */
async function checkBalances(
  rpc: Rpc,
  owner: PublicKey,
  mint: PublicKey
): Promise<void> {
  console.log("\n--- Balance Check ---");
  console.log("Owner:", owner.toBase58());
  console.log("Mint:", mint.toBase58());

  // Get SPL balance
  try {
    const splAta = await getAssociatedTokenAddress(mint, owner);
    const splAccount = await getAccount(rpc, splAta);
    console.log("\nSPL Balance:", formatTokenAmount(splAccount.amount, CONFIG.DECIMALS), "tokens");
  } catch {
    console.log("\nSPL Balance: 0 (no account)");
  }

  // Get Light balance (placeholder)
  console.log("Light Balance: [Use getLightTokenBalance from SDK]");

  console.log("\nExpected usage for Light balance:");
  console.log(`
  import { getLightTokenBalance } from "@lightprotocol/light-token";

  const lightBalance = await getLightTokenBalance(rpc, owner, mint);
  console.log("Light Balance:", lightBalance);
  `);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Token Program - Wrap and Unwrap");
  console.log("=".repeat(60));

  console.log("\n[INFO] Light Token Program supports seamless conversion between:");
  console.log("- SPL Tokens <-> Light Tokens");
  console.log("- Token-2022 (Extensions) <-> Light Tokens");
  console.log();
  console.log("This enables:");
  console.log("- Using Light tokens for high-frequency operations");
  console.log("- Converting back to SPL for DeFi integrations");
  console.log("- Cost savings while maintaining compatibility");

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Mock mint for demonstration
  const mint = Keypair.generate().publicKey;
  const splTokenAccount = Keypair.generate().publicKey;

  // Example 1: Check current balances
  await checkBalances(rpc, payer.publicKey, mint);

  // Example 2: Wrap SPL to Light
  await wrapSplToLight(rpc, payer, mint, 5_000_000_000, payer, splTokenAccount);

  // Example 3: Unwrap Light to SPL
  await unwrapLightToSpl(rpc, payer, mint, 2_000_000_000, payer, splTokenAccount);

  // Example 4: Wrap Token-2022
  await wrapToken2022(rpc, payer, mint, 1_000_000_000, payer, splTokenAccount);

  console.log("\n" + "=".repeat(60));
  console.log("Wrap/Unwrap Examples Complete");
  console.log();
  console.log("Key points:");
  console.log("1. Wrapping converts SPL -> Light (rent-free)");
  console.log("2. Unwrapping converts Light -> SPL (for DeFi)");
  console.log("3. Both Token (SPL) and Token-2022 supported");
  console.log("4. No value lost during conversion");
  console.log();
  console.log("For full implementation, check:");
  console.log("- https://www.zkcompression.com/light-token-program");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
