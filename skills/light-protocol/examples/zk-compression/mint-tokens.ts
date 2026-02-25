/**
 * Light Protocol - Mint Compressed Tokens
 *
 * This example demonstrates how to mint compressed tokens
 * to one or multiple recipients.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { createMint, mintTo } from "@lightprotocol/compressed-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  // Set to an existing mint, or leave empty to create a new one
  MINT_ADDRESS: process.env.MINT_ADDRESS || "",
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
// Mint Examples
// ============================================================================

/**
 * Mint tokens to a single recipient
 */
async function mintToSingleRecipient(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Minting to Single Recipient ---");
  console.log("Mint:", mint.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  const transactionSignature = await mintTo(
    rpc,
    payer, // Fee payer
    mint, // Mint address
    recipient, // Recipient
    payer, // Mint authority (signer)
    amount // Amount in base units
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Mint tokens to multiple recipients in a single transaction
 */
async function mintToMultipleRecipients(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  recipients: PublicKey[],
  amounts: number[]
): Promise<string> {
  console.log("\n--- Minting to Multiple Recipients ---");
  console.log("Mint:", mint.toBase58());
  console.log("Recipients:", recipients.length);

  if (recipients.length !== amounts.length) {
    throw new Error("Recipients and amounts arrays must have the same length");
  }

  // Log each recipient and amount
  for (let i = 0; i < recipients.length; i++) {
    console.log(`  ${i + 1}. ${recipients[i].toBase58()}: ${formatTokenAmount(amounts[i], CONFIG.DECIMALS)} tokens`);
  }

  const transactionSignature = await mintTo(
    rpc,
    payer,
    mint,
    recipients, // Array of recipients
    payer,
    amounts // Array of amounts (must match recipients length)
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Mint with batch processing for many recipients
 * (handles transaction size limits)
 */
async function batchMint(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  recipients: PublicKey[],
  amounts: number[],
  batchSize: number = 4 // Max ~4 recipients per transaction due to account limits
): Promise<string[]> {
  console.log("\n--- Batch Minting ---");
  console.log("Total Recipients:", recipients.length);
  console.log("Batch Size:", batchSize);

  const signatures: string[] = [];
  const totalBatches = Math.ceil(recipients.length / batchSize);

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batchRecipients = recipients.slice(i, i + batchSize);
    const batchAmounts = amounts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    console.log(`\nBatch ${batchNum}/${totalBatches}:`);
    for (let j = 0; j < batchRecipients.length; j++) {
      console.log(`  - ${batchRecipients[j].toBase58()}: ${formatTokenAmount(batchAmounts[j], CONFIG.DECIMALS)}`);
    }

    const sig = await mintTo(rpc, payer, mint, batchRecipients, payer, batchAmounts);
    signatures.push(sig);
    console.log(`  Transaction: ${sig}`);

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return signatures;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Mint Compressed Tokens");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  if (balance < 0.01 * 1e9) {
    console.log("\nInsufficient balance.");
    return;
  }

  // Get or create mint
  let mint: PublicKey;

  if (CONFIG.MINT_ADDRESS) {
    mint = new PublicKey(CONFIG.MINT_ADDRESS);
    console.log("\nUsing existing mint:", mint.toBase58());
  } else {
    console.log("\nCreating new mint...");
    const { mint: newMint } = await createMint(rpc, payer, payer.publicKey, CONFIG.DECIMALS);
    mint = newMint;
    console.log("Created mint:", mint.toBase58());
  }

  // Example 1: Mint to self
  const amount = 1_000_000_000; // 1 token with 9 decimals
  await mintToSingleRecipient(rpc, payer, mint, payer.publicKey, amount);

  // Example 2: Mint to multiple recipients
  const recipients = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];
  const amounts = [
    100_000_000, // 0.1 tokens
    200_000_000, // 0.2 tokens
    300_000_000, // 0.3 tokens
  ];
  await mintToMultipleRecipients(rpc, payer, mint, recipients, amounts);

  // Example 3: Batch mint to many recipients (commented out)
  // const manyRecipients = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
  // const manyAmounts = manyRecipients.map(() => 100_000_000);
  // await batchMint(rpc, payer, mint, manyRecipients, manyAmounts);

  // Verify balances
  console.log("\n--- Verifying Balances ---");
  const tokenAccounts = await rpc.getCompressedTokenAccountsByOwner(payer.publicKey, { mint });
  const totalBalance = tokenAccounts.items.reduce(
    (sum, account) => sum + BigInt(account.parsed.amount),
    BigInt(0)
  );
  console.log("Payer's token accounts:", tokenAccounts.items.length);
  console.log("Total balance:", formatTokenAmount(totalBalance, CONFIG.DECIMALS), "tokens");

  console.log("\n" + "=".repeat(60));
  console.log("Minting complete!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
