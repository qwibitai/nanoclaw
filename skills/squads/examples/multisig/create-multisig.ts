/**
 * Squads V4 Multisig: Create Multisig Example
 *
 * This example demonstrates how to create a new multisig with members
 * and different permission levels.
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";

const { Permission, Permissions } = multisig.types;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// ============================================================================
// MAIN EXAMPLES
// ============================================================================

/**
 * Example 1: Create a basic 2-of-3 multisig
 */
async function createBasicMultisig(
  connection: Connection,
  creator: Keypair,
  member2: PublicKey,
  member3: PublicKey
): Promise<{ multisigPda: PublicKey; vaultPda: PublicKey }> {
  console.log("\n=== Creating 2-of-3 Multisig ===");

  // Generate a unique create key (one-time use)
  const createKey = Keypair.generate();

  // Derive the multisig PDA
  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });

  // Derive the default vault PDA
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: 0,
  });

  console.log("Multisig PDA:", multisigPda.toString());
  console.log("Vault PDA:", vaultPda.toString());

  // Create the multisig
  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority: null, // Immutable config (recommended)
    threshold: 2, // Require 2 approvals
    members: [
      {
        key: creator.publicKey,
        permissions: Permissions.all(), // Can initiate, vote, execute
      },
      {
        key: member2,
        permissions: Permissions.all(),
      },
      {
        key: member3,
        permissions: Permissions.fromPermissions([Permission.Vote]), // Can only vote
      },
    ],
    timeLock: 0, // No time lock
    rentCollector: null,
  });

  console.log("Transaction signature:", signature);
  console.log("Multisig created successfully!");

  return { multisigPda, vaultPda };
}

/**
 * Example 2: Create a multisig with time lock for security
 */
async function createTimeLockMultisig(
  connection: Connection,
  creator: Keypair,
  members: PublicKey[]
): Promise<PublicKey> {
  console.log("\n=== Creating Multisig with Time Lock ===");

  const createKey = Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });

  // Create members array with the creator
  const allMembers = [
    { key: creator.publicKey, permissions: Permissions.all() },
    ...members.map((key) => ({
      key,
      permissions: Permissions.all(),
    })),
  ];

  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority: null,
    threshold: Math.ceil(allMembers.length / 2), // Majority threshold
    members: allMembers,
    timeLock: 86400, // 24 hours (in seconds)
    rentCollector: creator.publicKey, // Collect rent on account closure
  });

  console.log("Multisig with 24h time lock created:", multisigPda.toString());
  console.log("Transaction:", signature);

  return multisigPda;
}

/**
 * Example 3: Create a multisig with config authority (mutable config)
 */
async function createMutableConfigMultisig(
  connection: Connection,
  creator: Keypair,
  configAuthority: PublicKey
): Promise<PublicKey> {
  console.log("\n=== Creating Multisig with Config Authority ===");

  const createKey = Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });

  // Config authority can modify the multisig without proposal
  // Use with caution - recommended for testing or controlled scenarios
  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority, // Can modify config directly
    threshold: 1,
    members: [{ key: creator.publicKey, permissions: Permissions.all() }],
    timeLock: 0,
    rentCollector: null,
  });

  console.log("Mutable config multisig created:", multisigPda.toString());
  console.log("Config authority:", configAuthority.toString());

  return multisigPda;
}

/**
 * Example 4: Create a treasury multisig with multiple vaults
 */
async function createTreasuryMultisig(
  connection: Connection,
  creator: Keypair,
  treasuryMembers: PublicKey[]
): Promise<{ multisigPda: PublicKey; vaults: PublicKey[] }> {
  console.log("\n=== Creating Treasury Multisig ===");

  const createKey = Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });

  // Derive multiple vault PDAs
  const [operationsVault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const [reserveVault] = multisig.getVaultPda({ multisigPda, index: 1 });
  const [grantsVault] = multisig.getVaultPda({ multisigPda, index: 2 });

  console.log("Operations Vault (index 0):", operationsVault.toString());
  console.log("Reserve Vault (index 1):", reserveVault.toString());
  console.log("Grants Vault (index 2):", grantsVault.toString());

  const allMembers = [
    { key: creator.publicKey, permissions: Permissions.all() },
    ...treasuryMembers.map((key) => ({
      key,
      permissions: Permissions.all(),
    })),
  ];

  const signature = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority: null,
    threshold: Math.ceil((allMembers.length * 2) / 3), // 2/3 majority
    members: allMembers,
    timeLock: 172800, // 48 hours for large treasury
    rentCollector: null,
  });

  console.log("Treasury multisig created:", multisigPda.toString());
  console.log("Transaction:", signature);

  return {
    multisigPda,
    vaults: [operationsVault, reserveVault, grantsVault],
  };
}

/**
 * Fetch and display multisig account info
 */
async function getMultisigInfo(
  connection: Connection,
  multisigPda: PublicKey
): Promise<void> {
  console.log("\n=== Multisig Account Info ===");

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );

  console.log("Address:", multisigPda.toString());
  console.log("Threshold:", multisigAccount.threshold);
  console.log("Time Lock:", multisigAccount.timeLock, "seconds");
  console.log(
    "Transaction Index:",
    multisigAccount.transactionIndex.toString()
  );
  console.log("Members:");

  for (const member of multisigAccount.members) {
    const perms = [];
    if (member.permissions.mask & Permission.Initiate) perms.push("Initiate");
    if (member.permissions.mask & Permission.Vote) perms.push("Vote");
    if (member.permissions.mask & Permission.Execute) perms.push("Execute");

    console.log(`  - ${member.key.toString()}`);
    console.log(`    Permissions: ${perms.join(", ")}`);
  }

  // Get vault balance
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  const vaultBalance = await connection.getBalance(vaultPda);
  console.log("\nVault Balance:", vaultBalance / LAMPORTS_PER_SOL, "SOL");
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads V4 Multisig Creation Examples ===");

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");

  // Load wallet
  let wallet: Keypair;
  try {
    wallet = loadWallet(CONFIG.walletPath);
    console.log("Wallet loaded:", wallet.publicKey.toString());
  } catch {
    console.log("No wallet found, generating random keypair for demo");
    wallet = Keypair.generate();
    console.log("Demo wallet:", wallet.publicKey.toString());
    console.log("\nNote: Fund this wallet to run actual transactions");
    return;
  }

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Wallet balance:", balance / LAMPORTS_PER_SOL, "SOL");

  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.log("\nInsufficient balance. Need at least 0.1 SOL to create multisig.");
    return;
  }

  // Generate demo member keys
  const member2 = Keypair.generate().publicKey;
  const member3 = Keypair.generate().publicKey;

  // Create a basic multisig
  const { multisigPda, vaultPda } = await createBasicMultisig(
    connection,
    wallet,
    member2,
    member3
  );

  // Display multisig info
  await getMultisigInfo(connection, multisigPda);

  console.log("\n=== Summary ===");
  console.log("Multisig:", multisigPda.toString());
  console.log("Vault:", vaultPda.toString());
  console.log("\nFund the vault address to start using your multisig!");
}

main().catch(console.error);
