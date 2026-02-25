/**
 * Squads V4 Multisig: Spending Limits Example
 *
 * This example demonstrates how to create and use spending limits
 * that allow trusted members to execute transactions without full
 * multisig approval.
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";

const { Period } = multisig.types;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// Native SOL mint (system program)
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function getNextTransactionIndex(
  connection: Connection,
  multisigPda: PublicKey
): Promise<bigint> {
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );
  return BigInt(Number(multisigAccount.transactionIndex) + 1);
}

// ============================================================================
// MAIN EXAMPLES
// ============================================================================

/**
 * Example 1: Create a SOL spending limit (via config transaction)
 */
async function createSolSpendingLimit(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  trustedMembers: PublicKey[],
  allowedDestinations: PublicKey[],
  amountSol: number,
  period: typeof Period[keyof typeof Period]
): Promise<{ transactionIndex: bigint; spendingLimitPda: PublicKey }> {
  console.log("\n=== Creating SOL Spending Limit ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);

  // Generate a unique create key for this spending limit
  const spendingLimitCreateKey = Keypair.generate();

  // Derive the spending limit PDA
  const [spendingLimitPda] = multisig.getSpendingLimitPda({
    multisigPda,
    createKey: spendingLimitCreateKey.publicKey,
  });

  console.log("Spending Limit PDA:", spendingLimitPda.toString());
  console.log("Amount:", amountSol, "SOL per", getPeriodName(period));
  console.log("Trusted members:", trustedMembers.length);
  console.log("Allowed destinations:", allowedDestinations.length);

  // Create the config transaction to add the spending limit
  const signature = await multisig.rpc.configTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    actions: [
      {
        __kind: "AddSpendingLimit",
        createKey: spendingLimitCreateKey.publicKey,
        vaultIndex: 0,
        mint: SOL_MINT,
        amount: BigInt(amountSol * LAMPORTS_PER_SOL),
        period,
        members: trustedMembers,
        destinations: allowedDestinations,
      },
    ],
  });

  console.log("Config transaction created:", signature);
  console.log("Transaction index:", transactionIndex.toString());
  console.log("\nNote: This transaction needs to be approved and executed");

  return { transactionIndex, spendingLimitPda };
}

/**
 * Example 2: Create a USDC spending limit
 */
async function createUsdcSpendingLimit(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  trustedMembers: PublicKey[],
  allowedDestinations: PublicKey[],
  amountUsdc: number // In USDC (not atomic units)
): Promise<bigint> {
  console.log("\n=== Creating USDC Spending Limit ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const spendingLimitCreateKey = Keypair.generate();

  const [spendingLimitPda] = multisig.getSpendingLimitPda({
    multisigPda,
    createKey: spendingLimitCreateKey.publicKey,
  });

  // USDC has 6 decimals
  const amountAtomic = BigInt(amountUsdc * 1_000_000);

  console.log("Spending Limit PDA:", spendingLimitPda.toString());
  console.log("Amount:", amountUsdc, "USDC per day");

  const signature = await multisig.rpc.configTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    actions: [
      {
        __kind: "AddSpendingLimit",
        createKey: spendingLimitCreateKey.publicKey,
        vaultIndex: 0,
        mint: USDC_MINT,
        amount: amountAtomic,
        period: Period.Day,
        members: trustedMembers,
        destinations: allowedDestinations,
      },
    ],
  });

  console.log("Config transaction created:", signature);

  return transactionIndex;
}

/**
 * Example 3: Use a spending limit (no proposal needed!)
 */
async function useSpendingLimit(
  connection: Connection,
  member: Keypair,
  multisigPda: PublicKey,
  spendingLimitPda: PublicKey,
  destination: PublicKey,
  amountSol: number
): Promise<string> {
  console.log("\n=== Using Spending Limit ===");

  console.log("Member:", member.publicKey.toString());
  console.log("Destination:", destination.toString());
  console.log("Amount:", amountSol, "SOL");

  // Use the spending limit - this executes immediately without proposal
  const signature = await multisig.rpc.spendingLimitUse({
    connection,
    feePayer: member,
    multisigPda,
    member,
    spendingLimit: spendingLimitPda,
    mint: SOL_MINT,
    vaultIndex: 0,
    amount: BigInt(amountSol * LAMPORTS_PER_SOL),
    decimals: 9, // SOL has 9 decimals
    destination,
    memo: "Operational expense",
  });

  console.log("Transaction executed:", signature);
  console.log("No proposal was needed!");

  return signature;
}

/**
 * Example 4: Remove a spending limit
 */
async function removeSpendingLimit(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  spendingLimitPda: PublicKey
): Promise<bigint> {
  console.log("\n=== Removing Spending Limit ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);

  const signature = await multisig.rpc.configTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    actions: [
      {
        __kind: "RemoveSpendingLimit",
        spendingLimit: spendingLimitPda,
      },
    ],
  });

  console.log("Remove spending limit transaction created:", signature);
  console.log("Transaction index:", transactionIndex.toString());
  console.log("\nNote: This transaction needs to be approved and executed");

  return transactionIndex;
}

/**
 * Get spending limit info
 */
async function getSpendingLimitInfo(
  connection: Connection,
  spendingLimitPda: PublicKey
): Promise<void> {
  console.log("\n=== Spending Limit Info ===");

  try {
    const spendingLimit =
      await multisig.accounts.SpendingLimit.fromAccountAddress(
        connection,
        spendingLimitPda
      );

    console.log("Address:", spendingLimitPda.toString());
    console.log("Mint:", spendingLimit.mint.toString());
    console.log("Vault Index:", spendingLimit.vaultIndex);
    console.log("Amount:", spendingLimit.amount.toString());
    console.log("Period:", getPeriodName(spendingLimit.period));
    console.log("Remaining:", spendingLimit.remainingAmount.toString());
    console.log("Last Reset:", new Date(Number(spendingLimit.lastReset) * 1000).toISOString());

    console.log("\nAuthorized Members:");
    spendingLimit.members.forEach((member) =>
      console.log("  -", member.toString())
    );

    console.log("\nAllowed Destinations:");
    spendingLimit.destinations.forEach((dest) =>
      console.log("  -", dest.toString())
    );

    // Calculate if limit has reset
    const now = Math.floor(Date.now() / 1000);
    const lastReset = Number(spendingLimit.lastReset);
    const periodSeconds = getPeriodSeconds(spendingLimit.period);

    if (now - lastReset >= periodSeconds) {
      console.log("\n✓ Spending limit has reset and is fully available");
    } else {
      const remaining = spendingLimit.remainingAmount;
      console.log(`\nRemaining this period: ${remaining.toString()} atomic units`);
    }
  } catch (error) {
    console.log("Spending limit not found or not yet created");
  }
}

/**
 * Helper: Get period name
 */
function getPeriodName(period: typeof Period[keyof typeof Period]): string {
  switch (period) {
    case Period.OneTime:
      return "One-Time";
    case Period.Day:
      return "Day";
    case Period.Week:
      return "Week";
    case Period.Month:
      return "Month";
    default:
      return "Unknown";
  }
}

/**
 * Helper: Get period in seconds
 */
function getPeriodSeconds(period: typeof Period[keyof typeof Period]): number {
  switch (period) {
    case Period.OneTime:
      return Infinity;
    case Period.Day:
      return 86400;
    case Period.Week:
      return 604800;
    case Period.Month:
      return 2592000; // 30 days
    default:
      return 0;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads V4 Spending Limits Examples ===");

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");

  let wallet: Keypair;
  try {
    wallet = loadWallet(CONFIG.walletPath);
    console.log("Wallet loaded:", wallet.publicKey.toString());
  } catch {
    console.log("No wallet found. Create keypair.json to run examples.");
    return;
  }

  // Replace with your actual multisig PDA
  const multisigPda = new PublicKey("YOUR_MULTISIG_PDA_HERE");

  // Example trusted member and destination
  const trustedMember = wallet.publicKey;
  const allowedDestination = Keypair.generate().publicKey;

  console.log("\nMultisig:", multisigPda.toString());
  console.log("Trusted Member:", trustedMember.toString());
  console.log("Allowed Destination:", allowedDestination.toString());

  try {
    // Example 1: Create a spending limit
    const { transactionIndex, spendingLimitPda } = await createSolSpendingLimit(
      connection,
      wallet,
      multisigPda,
      [trustedMember], // Only this member can use the limit
      [allowedDestination], // Only to this destination
      1, // 1 SOL
      Period.Day // Per day
    );

    console.log("\n=== Summary ===");
    console.log("Created spending limit config transaction");
    console.log("Transaction index:", transactionIndex.toString());
    console.log("Spending limit PDA:", spendingLimitPda.toString());
    console.log("\nNext steps:");
    console.log("1. Create a proposal for the config transaction");
    console.log("2. Get multisig members to approve");
    console.log("3. Execute the config transaction");
    console.log("4. Then the spending limit can be used without proposals!");

    // After the config transaction is executed, you can use:
    // await useSpendingLimit(
    //   connection,
    //   wallet,
    //   multisigPda,
    //   spendingLimitPda,
    //   allowedDestination,
    //   0.5 // 0.5 SOL
    // );
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
