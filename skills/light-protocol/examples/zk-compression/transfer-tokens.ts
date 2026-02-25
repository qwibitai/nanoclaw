/**
 * Light Protocol - Transfer Compressed Tokens
 *
 * This example demonstrates how to transfer compressed tokens
 * between accounts. Note that compressed transfers use a
 * consume-and-create model.
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

async function getBalance(rpc: Rpc, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const accounts = await rpc.getCompressedTokenAccountsByOwner(owner, { mint });
  return accounts.items.reduce((sum, account) => sum + BigInt(account.parsed.amount), BigInt(0));
}

// ============================================================================
// Transfer Examples
// ============================================================================

/**
 * Basic transfer between two accounts
 */
async function basicTransfer(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  sender: Keypair,
  recipient: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Basic Transfer ---");
  console.log("From:", sender.publicKey.toBase58());
  console.log("To:", recipient.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  // Check sender balance first
  const senderBalance = await getBalance(rpc, sender.publicKey, mint);
  console.log("Sender balance:", formatTokenAmount(senderBalance, CONFIG.DECIMALS), "tokens");

  if (senderBalance < BigInt(amount)) {
    throw new Error(`Insufficient balance. Have ${senderBalance}, need ${amount}`);
  }

  const transactionSignature = await transfer(
    rpc,
    payer, // Fee payer
    mint, // Mint with token pool
    amount, // Amount to transfer
    sender, // Token owner (signer)
    recipient // Destination address
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Transfer with balance verification
 */
async function transferWithVerification(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  sender: Keypair,
  recipient: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Transfer with Verification ---");

  // Get balances before
  const senderBefore = await getBalance(rpc, sender.publicKey, mint);
  const recipientBefore = await getBalance(rpc, recipient, mint);

  console.log("Before transfer:");
  console.log("  Sender:", formatTokenAmount(senderBefore, CONFIG.DECIMALS), "tokens");
  console.log("  Recipient:", formatTokenAmount(recipientBefore, CONFIG.DECIMALS), "tokens");

  // Execute transfer
  const signature = await transfer(rpc, payer, mint, amount, sender, recipient);

  // Wait for confirmation
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Get balances after
  const senderAfter = await getBalance(rpc, sender.publicKey, mint);
  const recipientAfter = await getBalance(rpc, recipient, mint);

  console.log("\nAfter transfer:");
  console.log("  Sender:", formatTokenAmount(senderAfter, CONFIG.DECIMALS), "tokens");
  console.log("  Recipient:", formatTokenAmount(recipientAfter, CONFIG.DECIMALS), "tokens");

  // Verify
  const senderDiff = senderBefore - senderAfter;
  const recipientDiff = recipientAfter - recipientBefore;

  console.log("\nVerification:");
  console.log("  Sender change:", formatTokenAmount(senderDiff, CONFIG.DECIMALS), "tokens");
  console.log("  Recipient change:", formatTokenAmount(recipientDiff, CONFIG.DECIMALS), "tokens");
  console.log("  Match:", senderDiff === BigInt(amount) && recipientDiff === BigInt(amount));

  return signature;
}

/**
 * Transfer entire balance
 */
async function transferAll(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  sender: Keypair,
  recipient: PublicKey
): Promise<string> {
  console.log("\n--- Transfer Entire Balance ---");

  // Get current balance
  const balance = await getBalance(rpc, sender.publicKey, mint);

  if (balance === BigInt(0)) {
    throw new Error("No tokens to transfer");
  }

  console.log("Transferring all:", formatTokenAmount(balance, CONFIG.DECIMALS), "tokens");

  const signature = await transfer(rpc, payer, mint, Number(balance), sender, recipient);
  console.log("Transaction:", signature);

  return signature;
}

/**
 * Batch transfers to multiple recipients
 * Note: Each transfer is a separate transaction
 */
async function batchTransfers(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  sender: Keypair,
  transfers: Array<{ recipient: PublicKey; amount: number }>
): Promise<string[]> {
  console.log("\n--- Batch Transfers ---");
  console.log("Total transfers:", transfers.length);

  // Verify total balance
  const totalAmount = transfers.reduce((sum, t) => sum + BigInt(t.amount), BigInt(0));
  const balance = await getBalance(rpc, sender.publicKey, mint);

  console.log("Total to send:", formatTokenAmount(totalAmount, CONFIG.DECIMALS), "tokens");
  console.log("Available balance:", formatTokenAmount(balance, CONFIG.DECIMALS), "tokens");

  if (balance < totalAmount) {
    throw new Error("Insufficient balance for all transfers");
  }

  const signatures: string[] = [];

  for (let i = 0; i < transfers.length; i++) {
    const { recipient, amount } = transfers[i];
    console.log(`\nTransfer ${i + 1}/${transfers.length}:`);
    console.log("  To:", recipient.toBase58());
    console.log("  Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

    const sig = await transfer(rpc, payer, mint, amount, sender, recipient);
    signatures.push(sig);
    console.log("  Transaction:", sig);

    // Delay between transfers
    if (i < transfers.length - 1) {
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
  console.log("Light Protocol - Transfer Compressed Tokens");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  // Setup mint and tokens
  let mint: PublicKey;

  if (CONFIG.MINT_ADDRESS) {
    mint = new PublicKey(CONFIG.MINT_ADDRESS);
  } else {
    console.log("\nCreating new mint...");
    const { mint: newMint } = await createMint(rpc, payer, payer.publicKey, CONFIG.DECIMALS);
    mint = newMint;
    console.log("Created mint:", mint.toBase58());

    console.log("\nMinting initial tokens...");
    await mintTo(rpc, payer, mint, payer.publicKey, payer, 10_000_000_000); // 10 tokens
  }

  console.log("Mint:", mint.toBase58());

  // Check token balance
  const tokenBalance = await getBalance(rpc, payer.publicKey, mint);
  console.log("Token balance:", formatTokenAmount(tokenBalance, CONFIG.DECIMALS), "tokens");

  if (tokenBalance === BigInt(0)) {
    console.log("\nNo tokens to transfer. Mint some tokens first.");
    return;
  }

  // Generate a test recipient
  const recipient = Keypair.generate().publicKey;
  console.log("\nTest recipient:", recipient.toBase58());

  // Example 1: Basic transfer
  await basicTransfer(rpc, payer, mint, payer, recipient, 100_000_000); // 0.1 tokens

  // Example 2: Transfer with verification
  const recipient2 = Keypair.generate().publicKey;
  await transferWithVerification(rpc, payer, mint, payer, recipient2, 200_000_000); // 0.2 tokens

  // Example 3: Batch transfers (commented out)
  // const batchRecipients = [
  //   { recipient: Keypair.generate().publicKey, amount: 50_000_000 },
  //   { recipient: Keypair.generate().publicKey, amount: 50_000_000 },
  // ];
  // await batchTransfers(rpc, payer, mint, payer, batchRecipients);

  // Final balance check
  console.log("\n--- Final Balance ---");
  const finalBalance = await getBalance(rpc, payer.publicKey, mint);
  console.log("Token balance:", formatTokenAmount(finalBalance, CONFIG.DECIMALS), "tokens");

  console.log("\n" + "=".repeat(60));
  console.log("Transfer complete!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
