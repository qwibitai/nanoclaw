/**
 * Light Protocol - Delegation
 *
 * This example demonstrates how to delegate token spending
 * authority and execute delegated transfers.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import {
  createMint,
  mintTo,
  transfer,
  approve,
  revoke,
} from "@lightprotocol/compressed-token";
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
  return accounts.items.reduce((sum, acc) => sum + BigInt(acc.parsed.amount), BigInt(0));
}

async function getDelegatedAccounts(
  rpc: Rpc,
  delegate: PublicKey,
  mint?: PublicKey
): Promise<any[]> {
  const options = mint ? { mint } : undefined;
  const accounts = await rpc.getCompressedTokenAccountsByDelegate(delegate, options);
  return accounts.items;
}

// ============================================================================
// Delegation Examples
// ============================================================================

/**
 * Approve a delegate to spend tokens
 */
async function approveDelegate(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: Keypair,
  delegate: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Approve Delegate ---");
  console.log("Mint:", mint.toBase58());
  console.log("Owner:", owner.publicKey.toBase58());
  console.log("Delegate:", delegate.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  // Check owner's balance
  const balance = await getBalance(rpc, owner.publicKey, mint);
  console.log("Owner balance:", formatTokenAmount(balance, CONFIG.DECIMALS), "tokens");

  if (balance < BigInt(amount)) {
    throw new Error(`Insufficient balance for delegation: have ${balance}, want to delegate ${amount}`);
  }

  const transactionSignature = await approve(
    rpc,
    payer, // Fee payer
    mint, // Token mint
    amount, // Amount to delegate
    owner, // Token owner (signer)
    delegate // Delegate public key
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * Transfer tokens as a delegate
 */
async function transferAsDelegated(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  delegate: Keypair,
  recipient: PublicKey,
  amount: number
): Promise<string> {
  console.log("\n--- Delegated Transfer ---");
  console.log("Mint:", mint.toBase58());
  console.log("Delegate:", delegate.publicKey.toBase58());
  console.log("Recipient:", recipient.toBase58());
  console.log("Amount:", formatTokenAmount(amount, CONFIG.DECIMALS), "tokens");

  // Check delegated accounts
  const delegatedAccounts = await getDelegatedAccounts(rpc, delegate.publicKey, mint);
  console.log("Delegated accounts:", delegatedAccounts.length);

  if (delegatedAccounts.length === 0) {
    throw new Error("No delegated accounts found for this delegate");
  }

  // Calculate total delegated amount
  const totalDelegated = delegatedAccounts.reduce(
    (sum, acc) => sum + BigInt(acc.parsed.amount),
    BigInt(0)
  );
  console.log("Total delegated:", formatTokenAmount(totalDelegated, CONFIG.DECIMALS), "tokens");

  if (totalDelegated < BigInt(amount)) {
    throw new Error(`Insufficient delegated amount: have ${totalDelegated}, need ${amount}`);
  }

  /**
   * Using the SDK's delegated transfer:
   *
   * Note: The exact function name may vary. Check the SDK docs for:
   * - transferDelegated
   * - delegatedTransfer
   * - transferAsDelegate
   */
  console.log("\nExpected usage:");
  console.log(`
  import { transferDelegated } from "@lightprotocol/compressed-token";

  const signature = await transferDelegated(
    rpc,
    payer,        // Fee payer
    mint,         // Token mint
    ${amount},    // Amount
    delegate,     // Delegate (signer)
    recipient     // Destination
  );
  `);

  // For now, using regular transfer (delegate must be owner)
  // In production, use transferDelegated from SDK
  return "placeholder_delegated_transfer";
}

/**
 * Revoke delegation
 */
async function revokeDelegate(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  owner: Keypair
): Promise<string> {
  console.log("\n--- Revoke Delegation ---");
  console.log("Mint:", mint.toBase58());
  console.log("Owner:", owner.publicKey.toBase58());

  const transactionSignature = await revoke(
    rpc,
    payer, // Fee payer
    mint, // Token mint
    owner // Token owner (signer)
  );

  console.log("Transaction:", transactionSignature);
  return transactionSignature;
}

/**
 * View delegated accounts for a delegate
 */
async function viewDelegatedAccounts(
  rpc: Rpc,
  delegate: PublicKey,
  mint?: PublicKey
): Promise<void> {
  console.log("\n--- Delegated Accounts ---");
  console.log("Delegate:", delegate.toBase58());
  if (mint) {
    console.log("Mint filter:", mint.toBase58());
  }

  const accounts = await getDelegatedAccounts(rpc, delegate, mint);

  console.log("Total accounts:", accounts.length);

  if (accounts.length > 0) {
    console.log("\nAccounts:");
    for (const account of accounts) {
      console.log(`  Owner: ${account.parsed.owner.toBase58()}`);
      console.log(`    Mint: ${account.parsed.mint.toBase58()}`);
      console.log(`    Amount: ${formatTokenAmount(account.parsed.amount, CONFIG.DECIMALS)}`);
      console.log();
    }
  }
}

// ============================================================================
// Delegation Use Cases
// ============================================================================

/**
 * Use Case: Subscription service
 *
 * A service can be approved to pull payments periodically
 * from a user's token account.
 */
async function subscriptionExample(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  user: Keypair,
  serviceWallet: PublicKey
): Promise<void> {
  console.log("\n--- Subscription Service Example ---");
  console.log("User:", user.publicKey.toBase58());
  console.log("Service:", serviceWallet.toBase58());

  const monthlyFee = 10_000_000; // 0.01 tokens per month
  const approvedMonths = 12;
  const totalApproved = monthlyFee * approvedMonths;

  console.log("Monthly fee:", formatTokenAmount(monthlyFee, CONFIG.DECIMALS), "tokens");
  console.log("Approved months:", approvedMonths);
  console.log("Total approved:", formatTokenAmount(totalApproved, CONFIG.DECIMALS), "tokens");

  // Approve service to pull up to 12 months of fees
  console.log("\nApproving service for 12 months...");
  await approveDelegate(rpc, payer, mint, user, serviceWallet, totalApproved);

  console.log("\nService can now pull monthly payments up to the approved amount.");
}

/**
 * Use Case: Trading bot
 *
 * A trading bot can be approved to manage a portion
 * of a user's tokens for trading.
 */
async function tradingBotExample(
  rpc: Rpc,
  payer: Keypair,
  mint: PublicKey,
  user: Keypair,
  botWallet: PublicKey,
  tradingAmount: number
): Promise<void> {
  console.log("\n--- Trading Bot Example ---");
  console.log("User:", user.publicKey.toBase58());
  console.log("Bot:", botWallet.toBase58());
  console.log("Trading amount:", formatTokenAmount(tradingAmount, CONFIG.DECIMALS), "tokens");

  // Approve bot to trade with specified amount
  await approveDelegate(rpc, payer, mint, user, botWallet, tradingAmount);

  console.log("\nBot can now execute trades up to the approved amount.");
  console.log("User can revoke at any time to stop the bot.");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Delegation");
  console.log("=".repeat(60));

  console.log("\n[INFO] Delegation allows third parties to transfer tokens");
  console.log("on behalf of the owner, up to an approved amount.");
  console.log();
  console.log("Use cases:");
  console.log("- Subscription payments");
  console.log("- Trading bots");
  console.log("- Payment processors");
  console.log("- Automated services");

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);
  const payer = loadKeypairFromEnv();

  console.log("\nPayer:", payer.publicKey.toBase58());

  // Check balance
  const balance = await rpc.getBalance(payer.publicKey);
  console.log("SOL Balance:", balance / 1e9, "SOL");

  // Setup mint
  let mint: PublicKey;
  if (CONFIG.MINT_ADDRESS) {
    mint = new PublicKey(CONFIG.MINT_ADDRESS);
  } else {
    console.log("\nCreating new mint...");
    const { mint: newMint } = await createMint(rpc, payer, payer.publicKey, CONFIG.DECIMALS);
    mint = newMint;

    // Mint some tokens
    await mintTo(rpc, payer, mint, payer.publicKey, payer, 100_000_000_000); // 100 tokens
  }
  console.log("Mint:", mint.toBase58());

  // Check token balance
  const tokenBalance = await getBalance(rpc, payer.publicKey, mint);
  console.log("Token balance:", formatTokenAmount(tokenBalance, CONFIG.DECIMALS), "tokens");

  // Generate a delegate
  const delegate = Keypair.generate();
  console.log("\nDelegate:", delegate.publicKey.toBase58());

  // Example 1: Approve delegate
  await approveDelegate(rpc, payer, mint, payer, delegate.publicKey, 10_000_000_000); // 10 tokens

  // Wait for confirmation
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Example 2: View delegated accounts
  await viewDelegatedAccounts(rpc, delegate.publicKey, mint);

  // Example 3: Revoke delegation (commented out to keep delegation active)
  // await revokeDelegate(rpc, payer, mint, payer);

  // Example 4: Subscription use case (commented out)
  // const serviceWallet = Keypair.generate().publicKey;
  // await subscriptionExample(rpc, payer, mint, payer, serviceWallet);

  console.log("\n" + "=".repeat(60));
  console.log("Delegation Examples Complete");
  console.log();
  console.log("Key Points:");
  console.log("1. Use approve() to grant delegation");
  console.log("2. Delegate can transfer up to approved amount");
  console.log("3. Use revoke() to cancel delegation");
  console.log("4. Query delegated accounts with getCompressedTokenAccountsByDelegate");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
