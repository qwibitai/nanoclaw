/**
 * Light Protocol - Compress SPL Tokens
 *
 * This example demonstrates how to compress existing SPL tokens
 * into compressed format, reducing storage costs significantly.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import {
  createMint,
  createTokenPool,
  compress,
  compressSplTokenAccount,
} from "@lightprotocol/compressed-token";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint as createSplMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  mintTo as splMintTo,
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

// ============================================================================
// Compression Examples
// ============================================================================

/**
 * Create an SPL token account with tokens for testing
 */
async function setupSplTokens(
  rpc: Rpc,
  payer: Keypair
): Promise<{ mint: PublicKey; tokenAccount: PublicKey; amount: number }> {
  console.log("\n--- Setting up SPL Tokens ---");

  // Create SPL mint
  const splMint = await createSplMint(
    rpc,
    payer,
    payer.publicKey,
    null,
    CONFIG.DECIMALS,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("SPL Mint:", splMint.toBase58());

  // Create associated token account
  const ata = await getAssociatedTokenAddress(splMint, payer.publicKey);

  const createAtaIx = createAssociatedTokenAccountInstruction(
    payer.publicKey,
    ata,
    payer.publicKey,
    splMint
  );

  const tx = new Transaction().add(createAtaIx);
  await sendAndConfirmTransaction(rpc, tx, [payer]);
  console.log("Token Account:", ata.toBase58());

  // Mint SPL tokens
  const amount = 10_000_000_000; // 10 tokens
  await splMintTo(rpc, payer, splMint, ata, payer, amount);
  console.log("Minted:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  return { mint: splMint, tokenAccount: ata, amount };
}

/**
 * Compress specific amount of SPL tokens
 */
async function compressSpecificAmount(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  tokenAccount: PublicKey,
  amount: number,
  recipient: PublicKey
): Promise<string> {
  console.log("\n--- Compress Specific Amount ---");
  console.log("Mint:", mint.toBase58());
  console.log("Source Token Account:", tokenAccount.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");
  console.log("Recipient:", recipient.toBase58());

  // First, add token pool if not exists
  try {
    await createTokenPool(rpc, payer, mint);
    console.log("Token pool created");
  } catch (error: any) {
    if (!error.message?.includes("already exists")) {
      throw error;
    }
    console.log("Token pool already exists");
  }

  // Compress the tokens
  const transactionSignature = await compress(
    rpc,
    payer,
    mint,
    amount,
    payer, // Owner of SPL tokens
    recipient, // Recipient of compressed tokens
    tokenAccount // Source SPL token account
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Compress entire SPL token account
 */
async function compressEntireAccount(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  tokenAccount: PublicKey
): Promise<string> {
  console.log("\n--- Compress Entire Account ---");
  console.log("Mint:", mint.toBase58());
  console.log("Token Account:", tokenAccount.toBase58());

  // Check current balance
  const accountInfo = await getAccount(rpc, tokenAccount);
  console.log("Current SPL balance:", formatTokenAmount(accountInfo.amount, CONFIG.DECIMALS), "tokens");

  // Ensure token pool exists
  try {
    await createTokenPool(rpc, payer, mint);
    console.log("Token pool created");
  } catch (error: any) {
    if (!error.message?.includes("already exists")) {
      throw error;
    }
    console.log("Token pool already exists");
  }

  // Compress entire account
  const transactionSignature = await compressSplTokenAccount(
    rpc,
    payer,
    mint,
    payer, // Owner
    tokenAccount
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Compress with partial retention (keep some in SPL format)
 */
async function compressWithRetention(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  tokenAccount: PublicKey,
  keepAmount: number
): Promise<string> {
  console.log("\n--- Compress with Partial Retention ---");
  console.log("Mint:", mint.toBase58());
  console.log("Token Account:", tokenAccount.toBase58());
  console.log("Keep in SPL format:", formatTokenAmount(keepAmount, CONFIG.DECIMALS), "tokens");

  // Check current balance
  const accountInfo = await getAccount(rpc, tokenAccount);
  const currentBalance = Number(accountInfo.amount);
  console.log("Current balance:", formatTokenAmount(currentBalance, CONFIG.DECIMALS), "tokens");
  console.log("Will compress:", formatTokenAmount(currentBalance - keepAmount, CONFIG.DECIMALS), "tokens");

  if (currentBalance <= keepAmount) {
    throw new Error("Keep amount must be less than current balance");
  }

  // Ensure token pool exists
  try {
    await createTokenPool(rpc, payer, mint);
  } catch (error: any) {
    if (!error.message?.includes("already exists")) {
      throw error;
    }
  }

  // Compress with retention
  const transactionSignature = await compressSplTokenAccount(
    rpc,
    payer,
    mint,
    payer,
    tokenAccount,
    keepAmount // Amount to keep in SPL format
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Compress SPL Tokens");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  if (balance < 0.05 * 1e9) {
    console.log("\nInsufficient balance. Need at least 0.05 SOL.");
    return;
  }

  // Setup: Create SPL tokens to compress
  const { mint, tokenAccount, amount } = await setupSplTokens(rpc, payer);

  // Check initial compressed balance
  console.log("\n--- Initial State ---");
  let compressedBalance = await getCompressedBalance(rpc, payer.publicKey, mint);
  console.log("Compressed balance:", formatTokenAmount(compressedBalance, CONFIG.DECIMALS), "tokens");

  // Example 1: Compress specific amount to self
  await compressSpecificAmount(
    rpc,
    payer,
    mint,
    tokenAccount,
    2_000_000_000, // 2 tokens
    payer.publicKey
  );

  // Wait for indexer
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check balance after first compression
  console.log("\n--- After First Compression ---");
  compressedBalance = await getCompressedBalance(rpc, payer.publicKey, mint);
  console.log("Compressed balance:", formatTokenAmount(compressedBalance, CONFIG.DECIMALS), "tokens");

  const splAccount = await getAccount(rpc, tokenAccount);
  console.log("SPL balance:", formatTokenAmount(splAccount.amount, CONFIG.DECIMALS), "tokens");

  // Example 2: Compress with retention (keep 3 tokens in SPL)
  await compressWithRetention(rpc, payer, mint, tokenAccount, 3_000_000_000);

  // Wait for indexer
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Final state
  console.log("\n--- Final State ---");
  compressedBalance = await getCompressedBalance(rpc, payer.publicKey, mint);
  console.log("Compressed balance:", formatTokenAmount(compressedBalance, CONFIG.DECIMALS), "tokens");

  try {
    const finalSplAccount = await getAccount(rpc, tokenAccount);
    console.log("SPL balance:", formatTokenAmount(finalSplAccount.amount, CONFIG.DECIMALS), "tokens");
  } catch {
    console.log("SPL balance: 0 (account closed)");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Compression complete!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
