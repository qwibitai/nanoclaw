/**
 * Light Protocol - Decompress Tokens
 *
 * This example demonstrates how to decompress compressed tokens
 * back to regular SPL token format.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { createMint, mintTo, decompress } from "@lightprotocol/compressed-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
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

async function getCompressedBalance(rpc: Rpc, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
  return accounts.items.reduce((sum, account) => sum + BigInt(account.parsed.amount), BigInt(0));
}

async function getSplBalance(rpc: Rpc, tokenAccount: PublicKey): Promise<bigint> {
  try {
    const account = await getAccount(rpc, tokenAccount);
    return account.amount;
  } catch {
    return BigInt(0);
  }
}

// ============================================================================
// Decompression Examples
// ============================================================================

/**
 * Ensure SPL token account exists
 */
async function ensureTokenAccount(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner);

  try {
    await getAccount(rpc, ata);
    console.log("Token account exists:", ata.toBase58());
  } catch {
    console.log("Creating token account...");
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(rpc, tx, [payer]);
    console.log("Token account created:", ata.toBase58());
  }

  return ata;
}

/**
 * Decompress specific amount to SPL format
 */
async function decompressTokens(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: Keypair,
  amount: number
): Promise<string> {
  console.log("\n--- Decompress Tokens ---");
  console.log("Mint:", mint.toBase58());
  console.log("Owner:", owner.publicKey.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  // Check compressed balance
  const compressedBalance = await getCompressedBalance(rpc, owner.publicKey, mint);
  console.log("Compressed balance:", formatTokenAmount(compressedBalance, CONFIG.DECIMALS), "tokens");

  if (compressedBalance < BigInt(amount)) {
    throw new Error(`Insufficient compressed balance. Have ${compressedBalance}, need ${amount}`);
  }

  // Ensure SPL token account exists
  const tokenAccount = await ensureTokenAccount(rpc, payer, mint, owner.publicKey);

  // Get SPL balance before
  const splBefore = await getSplBalance(rpc, tokenAccount);
  console.log("SPL balance before:", formatTokenAmount(splBefore, CONFIG.DECIMALS), "tokens");

  // Decompress
  const transactionSignature = await decompress(
    rpc,
    payer, // Fee payer
    mint, // Mint address
    amount, // Amount to decompress
    owner, // Compressed token owner (signer)
    tokenAccount // Destination SPL token account
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Decompress to a different recipient
 */
async function decompressToRecipient(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: Keypair,
  recipient: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Decompress to Different Recipient ---");
  console.log("Mint:", mint.toBase58());
  console.log("Owner:", owner.publicKey.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  // Ensure recipient's token account exists
  const recipientAta = await ensureTokenAccount(rpc, payer, mint, recipient);

  // Decompress to recipient
  const transactionSignature = await decompress(
    rpc,
    payer,
    mint,
    amount,
    owner,
    recipientAta // Recipient's token account
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Decompress all compressed tokens
 */
async function decompressAll(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: Keypair
): Promise<string> {
  console.log("\n--- Decompress All Tokens ---");

  // Get total compressed balance
  const balance = await getCompressedBalance(rpc, owner.publicKey, mint);

  if (balance === BigInt(0)) {
    throw new Error("No compressed tokens to decompress");
  }

  console.log("Total compressed:", formatTokenAmount(balance, CONFIG.DECIMALS), "tokens");

  // Ensure token account exists
  const tokenAccount = await ensureTokenAccount(rpc, payer, mint, owner.publicKey);

  // Decompress all
  const transactionSignature = await decompress(
    rpc,
    payer,
    mint,
    Number(balance),
    owner,
    tokenAccount
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Decompress Tokens");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check SOL balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  // Get or create mint with compressed tokens
  let mint: PublicKey;

  if (CONFIG.MINT_ADDRESS) {
    mint = new PublicKey(CONFIG.MINT_ADDRESS);
    console.log("\nUsing existing mint:", mint.toBase58());
  } else {
    console.log("\nCreating new mint and minting compressed tokens...");
    const { mint: newMint } = await createMint(rpc, payer, payer.publicKey, CONFIG.DECIMALS);
    mint = newMint;

    // Mint some compressed tokens
    await mintTo(rpc, payer, mint, payer.publicKey, payer, 5_000_000_000); // 5 tokens
    console.log("Minted 5 compressed tokens");
  }

  // Check compressed balance
  const compressedBalance = await getCompressedBalance(rpc, payer.publicKey, mint);
  console.log("\nCompressed balance:", formatTokenAmount(compressedBalance, CONFIG.DECIMALS), "tokens");

  if (compressedBalance === BigInt(0)) {
    console.log("No compressed tokens. Mint some first.");
    return;
  }

  // Example 1: Decompress specific amount
  await decompressTokens(rpc, payer, mint, payer, 1_000_000_000); // 1 token

  // Wait for confirmation
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check balances after
  console.log("\n--- After Decompression ---");
  const compressedAfter = await getCompressedBalance(rpc, payer.publicKey, mint);
  const ata = await getAssociatedTokenAddress(mint, payer.publicKey);
  const splAfter = await getSplBalance(rpc, ata);

  console.log("Compressed balance:", formatTokenAmount(compressedAfter, CONFIG.DECIMALS), "tokens");
  console.log("SPL balance:", formatTokenAmount(splAfter, CONFIG.DECIMALS), "tokens");

  // Example 2: Decompress to different recipient (commented out)
  // const recipient = Keypair.generate().publicKey;
  // await decompressToRecipient(rpc, payer, mint, payer, recipient, 500_000_000);

  // Example 3: Decompress all remaining (commented out)
  // await decompressAll(rpc, payer, mint, payer);

  console.log("\n" + "=".repeat(60));
  console.log("Decompression complete!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
