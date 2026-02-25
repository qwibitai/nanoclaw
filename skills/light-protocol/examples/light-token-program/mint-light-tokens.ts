/**
 * Light Token Program - Mint to Light-ATA
 *
 * This example demonstrates how to mint Light tokens to
 * Light Associated Token Accounts (Light-ATAs).
 *
 * Light-ATAs are rent-free token accounts that provide
 * significant cost savings over standard SPL token accounts.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  LIGHT_MINT_ADDRESS: process.env.LIGHT_MINT_ADDRESS || "",
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
// Light Token Minting Examples
// ============================================================================

/**
 * Mint Light tokens to a Light-ATA
 *
 * Light-ATAs are automatically created if they don't exist,
 * making minting to new addresses very efficient.
 */
async function mintToLightAta(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  mintAuthority: Keypair,
  amount: number
): Promise<string> {
  console.log("\n--- Mint to Light-ATA ---");
  console.log("Mint:", mint.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  /**
   * Using the Light Token SDK:
   *
   * import { mintToLightAta } from "@lightprotocol/light-token";
   *
   * const transactionSignature = await mintToLightAta(
   *   rpc,
   *   payer,
   *   mint,
   *   recipient,
   *   mintAuthority,
   *   amount
   * );
   */

  console.log("\nExpected usage:");
  console.log(`
  import { mintToLightAta } from "@lightprotocol/light-token";

  const signature = await mintToLightAta(
    rpc,
    payer,           // Fee payer
    mint,            // Light Token mint
    recipient,       // Recipient address
    mintAuthority,   // Mint authority (signer)
    ${amount}        // Amount in base units
  );
  `);

  return "placeholder_signature";
}

/**
 * Mint Light tokens to multiple recipients
 */
async function batchMintToLightAtas(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  recipients: PublicKey[],
  mintAuthority: Keypair,
  amounts: number[]
): Promise<string> {
  console.log("\n--- Batch Mint to Light-ATAs ---");
  console.log("Mint:", mint.toBase58());
  console.log("Recipients:", recipients.length);

  if (recipients.length !== amounts.length) {
    throw new Error("Recipients and amounts arrays must match");
  }

  for (let i = 0; i < recipients.length; i++) {
    console.log(`  ${i + 1}. ${recipients[i].toBase58()}: ${formatTokenAmount(amounts[i], CONFIG.DECIMALS)} tokens`);
  }

  console.log("\nExpected usage:");
  console.log(`
  import { mintToLightAta } from "@lightprotocol/light-token";

  // Batch minting to multiple recipients
  const signature = await mintToLightAta(
    rpc,
    payer,
    mint,
    recipients,      // Array of recipient addresses
    mintAuthority,
    amounts          // Array of amounts
  );
  `);

  return "placeholder_signature";
}

/**
 * Get Light-ATA address for a given owner and mint
 */
function getLightAtaAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  console.log("\n--- Get Light-ATA Address ---");
  console.log("Owner:", owner.toBase58());
  console.log("Mint:", mint.toBase58());

  /**
   * Light-ATAs are derived deterministically from the owner and mint.
   *
   * import { getLightAssociatedTokenAddress } from "@lightprotocol/light-token";
   *
   * const lightAta = await getLightAssociatedTokenAddress(owner, mint);
   */

  console.log("\nExpected usage:");
  console.log(`
  import { getLightAssociatedTokenAddress } from "@lightprotocol/light-token";

  const lightAta = await getLightAssociatedTokenAddress(
    owner,   // Token owner
    mint     // Light Token mint
  );
  `);

  // Placeholder - actual implementation uses PDA derivation
  return owner;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Token Program - Mint to Light-ATA");
  console.log("=".repeat(60));

  console.log("\n[INFO] Light-ATAs are rent-free token accounts that:");
  console.log("- Are created automatically when minting");
  console.log("- Cost ~200x less than standard SPL ATAs");
  console.log("- Support the same token operations as SPL");

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  // Mock mint for demonstration
  const mint = CONFIG.LIGHT_MINT_ADDRESS
    ? new PublicKey(CONFIG.LIGHT_MINT_ADDRESS)
    : Keypair.generate().publicKey;

  console.log("Light Mint:", mint.toBase58());

  // Example 1: Get Light-ATA address
  getLightAtaAddress(payer.publicKey, mint);

  // Example 2: Mint to single recipient
  const recipient = Keypair.generate().publicKey;
  await mintToLightAta(rpc, payer, mint, recipient, payer, 1_000_000_000);

  // Example 3: Batch mint to multiple recipients
  const recipients = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];
  const amounts = [100_000_000, 200_000_000, 300_000_000];
  await batchMintToLightAtas(rpc, payer, mint, recipients, payer, amounts);

  console.log("\n" + "=".repeat(60));
  console.log("Light Token Minting Examples Complete");
  console.log();
  console.log("For full implementation, check:");
  console.log("- https://www.zkcompression.com/light-token-program/cookbook");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
