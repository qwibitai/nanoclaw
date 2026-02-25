/**
 * Light Protocol - Batch Operations
 *
 * This example demonstrates advanced batch operations for
 * handling large-scale token distributions efficiently.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import { createMint, mintTo, transfer } from "@lightprotocol/compressed-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  MINT_ADDRESS: process.env.MINT_ADDRESS || "",
  DECIMALS: 9,
  // Maximum accounts per transaction (Light Protocol limit)
  MAX_ACCOUNTS_PER_TX: 4,
  // Delay between transactions (ms) to avoid rate limiting
  TX_DELAY: 500,
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBalance(rpc: Rpc, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
  return accounts.items.reduce((sum, acc) => sum + BigInt(acc.parsed.amount), BigInt(0));
}

// ============================================================================
// Batch Operation Types
// ============================================================================

interface BatchMintRecipient {
  address: PublicKey;
  amount: number;
}

interface BatchTransferRecipient {
  address: PublicKey;
  amount: number;
}

interface BatchResult {
  successful: number;
  failed: number;
  signatures: string[];
  errors: Error[];
}

// ============================================================================
// Batch Minting
// ============================================================================

/**
 * Batch mint tokens to many recipients
 *
 * Splits large distributions into multiple transactions
 * to handle the 4-account-per-transaction limit.
 */
async function batchMint(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  mintAuthority: Keypair,
  recipients: BatchMintRecipient[]
): Promise<BatchResult> {
  console.log("\n--- Batch Minting ---");
  console.log("Total recipients:", recipients.length);
  console.log("Batch size:", CONFIG.MAX_ACCOUNTS_PER_TX);

  const totalAmount = recipients.reduce((sum, r) => sum + BigInt(r.amount), BigInt(0));
  console.log("Total amount:", formatTokenAmount(totalAmount, CONFIG.DECIMALS), "tokens");

  const result: BatchResult = {
    successful: 0,
    failed: 0,
    signatures: [],
    errors: [],
  };

  const totalBatches = Math.ceil(recipients.length / CONFIG.MAX_ACCOUNTS_PER_TX);

  for (let i = 0; i < recipients.length; i += CONFIG.MAX_ACCOUNTS_PER_TX) {
    const batchNum = Math.floor(i / CONFIG.MAX_ACCOUNTS_PER_TX) + 1;
    const batch = recipients.slice(i, i + CONFIG.MAX_ACCOUNTS_PER_TX);

    console.log(`\nBatch ${batchNum}/${totalBatches}:`);

    const addresses = batch.map((r) => r.address);
    const amounts = batch.map((r) => r.amount);

    try {
      const signature = await mintTo(rpc, payer, mint, addresses, mintAuthority, amounts);
      result.signatures.push(signature);
      result.successful += batch.length;
      console.log(`  Success: ${signature.slice(0, 20)}...`);
    } catch (error: any) {
      result.failed += batch.length;
      result.errors.push(error);
      console.log(`  Failed: ${error.message}`);
    }

    // Delay between batches
    if (i + CONFIG.MAX_ACCOUNTS_PER_TX < recipients.length) {
      await sleep(CONFIG.TX_DELAY);
    }
  }

  return result;
}

// ============================================================================
// Batch Transfers
// ============================================================================

/**
 * Batch transfer tokens to many recipients
 *
 * Note: Each transfer is a separate transaction because
 * compressed token transfers consume the sender's accounts.
 */
async function batchTransfer(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  sender: Keypair,
  recipients: BatchTransferRecipient[]
): Promise<BatchResult> {
  console.log("\n--- Batch Transfers ---");
  console.log("Total recipients:", recipients.length);

  // Verify sender has enough balance
  const senderBalance = await getBalance(rpc, sender.publicKey, mint);
  const totalAmount = recipients.reduce((sum, r) => sum + BigInt(r.amount), BigInt(0));

  console.log("Sender balance:", formatTokenAmount(senderBalance, CONFIG.DECIMALS), "tokens");
  console.log("Total to send:", formatTokenAmount(totalAmount, CONFIG.DECIMALS), "tokens");

  if (senderBalance < totalAmount) {
    throw new Error(`Insufficient balance: have ${senderBalance}, need ${totalAmount}`);
  }

  const result: BatchResult = {
    successful: 0,
    failed: 0,
    signatures: [],
    errors: [],
  };

  for (let i = 0; i < recipients.length; i++) {
    const { address, amount } = recipients[i];
    console.log(`\nTransfer ${i + 1}/${recipients.length}:`);
    console.log(`  To: ${address.toBase58()}`);
    console.log(`  Amount: ${formatTokenAmount(amount, CONFIG.DECIMALS)}`);

    try {
      const signature = await transfer(rpc, payer, mint, amount, sender, address);
      result.signatures.push(signature);
      result.successful++;
      console.log(`  Success: ${signature.slice(0, 20)}...`);
    } catch (error: any) {
      result.failed++;
      result.errors.push(error);
      console.log(`  Failed: ${error.message}`);
    }

    // Delay between transfers
    if (i < recipients.length - 1) {
      await sleep(CONFIG.TX_DELAY);
    }
  }

  return result;
}

// ============================================================================
// Airdrop Pattern
// ============================================================================

/**
 * Airdrop tokens to a large list of addresses
 *
 * Optimized pattern for airdrops with progress tracking
 * and error recovery.
 */
async function airdrop(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  mintAuthority: Keypair,
  addresses: PublicKey[],
  amountPerAddress: number,
  onProgress?: (completed: number, total: number) => void
): Promise<BatchResult> {
  console.log("\n--- Airdrop ---");
  console.log("Recipients:", addresses.length);
  console.log("Amount per recipient:", formatTokenAmount(amountPerAddress, CONFIG.DECIMALS), "tokens");
  console.log("Total amount:", formatTokenAmount(BigInt(amountPerAddress) * BigInt(addresses.length), CONFIG.DECIMALS), "tokens");

  const recipients: BatchMintRecipient[] = addresses.map((address) => ({
    address,
    amount: amountPerAddress,
  }));

  const result: BatchResult = {
    successful: 0,
    failed: 0,
    signatures: [],
    errors: [],
  };

  const totalBatches = Math.ceil(addresses.length / CONFIG.MAX_ACCOUNTS_PER_TX);

  for (let i = 0; i < recipients.length; i += CONFIG.MAX_ACCOUNTS_PER_TX) {
    const batchNum = Math.floor(i / CONFIG.MAX_ACCOUNTS_PER_TX) + 1;
    const batch = recipients.slice(i, i + CONFIG.MAX_ACCOUNTS_PER_TX);

    const batchAddresses = batch.map((r) => r.address);
    const batchAmounts = batch.map((r) => r.amount);

    try {
      const signature = await mintTo(rpc, payer, mint, batchAddresses, mintAuthority, batchAmounts);
      result.signatures.push(signature);
      result.successful += batch.length;
    } catch (error: any) {
      result.failed += batch.length;
      result.errors.push(error);
    }

    // Progress callback
    if (onProgress) {
      onProgress(Math.min(i + CONFIG.MAX_ACCOUNTS_PER_TX, addresses.length), addresses.length);
    }

    // Log progress every 10 batches
    if (batchNum % 10 === 0 || batchNum === totalBatches) {
      console.log(`Progress: ${batchNum}/${totalBatches} batches (${result.successful} succeeded, ${result.failed} failed)`);
    }

    // Delay
    if (i + CONFIG.MAX_ACCOUNTS_PER_TX < recipients.length) {
      await sleep(CONFIG.TX_DELAY);
    }
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Batch Operations");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  if (balance < 0.1 * 1e9) {
    console.log("\nInsufficient balance for batch operations.");
    return;
  }

  // Setup mint
  let mint: PublicKey;
  if (CONFIG.MINT_ADDRESS) {
    mint = new PublicKey(CONFIG.MINT_ADDRESS);
  } else {
    console.log("\nCreating new mint...");
    const { mint: newMint } = await createMint(rpc, payer, payer.publicKey, CONFIG.DECIMALS);
    mint = newMint;
    console.log("Mint:", mint.toBase58());
  }

  // Example 1: Batch mint to 10 recipients
  console.log("\n" + "=".repeat(40));
  console.log("Example 1: Batch Mint");
  console.log("=".repeat(40));

  const mintRecipients: BatchMintRecipient[] = Array.from({ length: 10 }, () => ({
    address: Keypair.generate().publicKey,
    amount: 100_000_000, // 0.1 tokens each
  }));

  const mintResult = await batchMint(rpc, payer, mint, payer, mintRecipients);
  console.log("\nMint Result:");
  console.log(`  Successful: ${mintResult.successful}`);
  console.log(`  Failed: ${mintResult.failed}`);
  console.log(`  Transactions: ${mintResult.signatures.length}`);

  // Example 2: Airdrop with progress tracking
  console.log("\n" + "=".repeat(40));
  console.log("Example 2: Airdrop with Progress");
  console.log("=".repeat(40));

  const airdropAddresses = Array.from({ length: 8 }, () => Keypair.generate().publicKey);

  const airdropResult = await airdrop(
    rpc,
    payer,
    mint,
    payer,
    airdropAddresses,
    50_000_000, // 0.05 tokens each
    (completed, total) => {
      // Progress callback - could update a UI here
    }
  );

  console.log("\nAirdrop Result:");
  console.log(`  Successful: ${airdropResult.successful}`);
  console.log(`  Failed: ${airdropResult.failed}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Batch Operations Complete");
  console.log();
  console.log("Key Points:");
  console.log("1. Max 4 accounts per transaction");
  console.log("2. Split large distributions into batches");
  console.log("3. Add delays between transactions to avoid rate limits");
  console.log("4. Track progress for large airdrops");
  console.log("5. Handle errors gracefully with retry logic");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
