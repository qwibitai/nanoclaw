/**
 * Light Protocol - Query Compressed Accounts
 *
 * This example demonstrates how to query compressed accounts,
 * token balances, and transaction history using the Light Protocol RPC.
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
  // Optional: specify addresses to query
  OWNER_ADDRESS: process.env.OWNER_ADDRESS || "",
  MINT_ADDRESS: process.env.MINT_ADDRESS || "",
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

function formatTokenAmount(amount: string | bigint | number, decimals: number = 9): string {
  return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

// ============================================================================
// Query Examples
// ============================================================================

/**
 * Get all compressed accounts for an owner
 */
async function getCompressedAccounts(rpc: Rpc, owner: PublicKey): Promise<void> {
  console.log("\n--- Compressed Accounts ---");
  console.log("Owner:", owner.toBase58());

  const result = await rpc.getCompressedAccountsByOwner(owner);

  console.log("Total accounts:", result.items.length);

  if (result.items.length > 0) {
    console.log("\nAccounts:");
    for (const account of result.items.slice(0, 5)) {
      console.log(`  Hash: ${truncateAddress(account.hash)}`);
      console.log(`    Lamports: ${account.lamports}`);
      console.log(`    Tree: ${truncateAddress(account.tree)}`);
      console.log(`    Leaf Index: ${account.leafIndex}`);
      console.log();
    }

    if (result.items.length > 5) {
      console.log(`  ... and ${result.items.length - 5} more accounts`);
    }
  }

  if (result.cursor) {
    console.log("Has more results (cursor available)");
  }
}

/**
 * Get compressed token accounts for an owner
 */
async function getTokenAccounts(
  rpc: Rpc,
  owner: PublicKey,
  mint?: PublicKey
): Promise<void> {
  console.log("\n--- Compressed Token Accounts ---");
  console.log("Owner:", owner.toBase58());
  if (mint) {
    console.log("Mint filter:", mint.toBase58());
  }

  const options = mint ? { mint } : undefined;
  const result = await rpc.getCompressedTokenAccountsByOwner(owner, options);

  console.log("Total token accounts:", result.items.length);

  if (result.items.length > 0) {
    // Group by mint
    const byMint = new Map<string, typeof result.items>();

    for (const account of result.items) {
      const mintKey = account.parsed.mint.toBase58();
      if (!byMint.has(mintKey)) {
        byMint.set(mintKey, []);
      }
      byMint.get(mintKey)!.push(account);
    }

    console.log(`\nUnique mints: ${byMint.size}`);

    for (const [mintKey, accounts] of byMint) {
      const totalBalance = accounts.reduce(
        (sum, acc) => sum + BigInt(acc.parsed.amount),
        BigInt(0)
      );

      console.log(`\n  Mint: ${truncateAddress(mintKey)}`);
      console.log(`    Accounts: ${accounts.length}`);
      console.log(`    Total Balance: ${formatTokenAmount(totalBalance)}`);

      // Show individual accounts
      for (const account of accounts.slice(0, 3)) {
        console.log(`    - Hash: ${truncateAddress(account.hash)}`);
        console.log(`      Amount: ${formatTokenAmount(account.parsed.amount)}`);
        if (account.parsed.delegate) {
          console.log(`      Delegate: ${truncateAddress(account.parsed.delegate.toBase58())}`);
        }
      }

      if (accounts.length > 3) {
        console.log(`    ... and ${accounts.length - 3} more`);
      }
    }
  }
}

/**
 * Get token balances summary for an owner
 */
async function getTokenBalances(rpc: Rpc, owner: PublicKey): Promise<void> {
  console.log("\n--- Token Balances Summary ---");
  console.log("Owner:", owner.toBase58());

  const result = await rpc.getCompressedTokenBalancesByOwner(owner);

  console.log("Total balances:", result.items.length);

  if (result.items.length > 0) {
    console.log("\nBalances:");
    for (const balance of result.items) {
      console.log(`  Mint: ${truncateAddress(balance.mint.toBase58())}`);
      console.log(`    Balance: ${formatTokenAmount(balance.balance)}`);
    }
  }
}

/**
 * Get all holders of a specific mint
 */
async function getMintHolders(rpc: Rpc, mint: PublicKey): Promise<void> {
  console.log("\n--- Mint Token Holders ---");
  console.log("Mint:", mint.toBase58());

  const result = await rpc.getCompressedMintTokenHolders(mint);

  console.log("Total holders:", result.items.length);

  if (result.items.length > 0) {
    console.log("\nTop holders:");
    for (const holder of result.items.slice(0, 10)) {
      console.log(`  ${truncateAddress(holder.owner.toBase58())}: ${formatTokenAmount(holder.balance)}`);
    }

    if (result.items.length > 10) {
      console.log(`  ... and ${result.items.length - 10} more holders`);
    }
  }
}

/**
 * Get transaction signatures for an owner
 */
async function getTransactionHistory(rpc: Rpc, owner: PublicKey): Promise<void> {
  console.log("\n--- Transaction History ---");
  console.log("Owner:", owner.toBase58());

  const result = await rpc.getCompressionSignaturesForOwner(owner.toBase58());

  console.log("Total signatures:", result.items.length);

  if (result.items.length > 0) {
    console.log("\nRecent transactions:");
    for (const sig of result.items.slice(0, 5)) {
      console.log(`  ${truncateAddress(sig.signature)}`);
      console.log(`    Slot: ${sig.slot}`);
      if (sig.blockTime) {
        console.log(`    Time: ${new Date(sig.blockTime * 1000).toISOString()}`);
      }
    }

    if (result.items.length > 5) {
      console.log(`  ... and ${result.items.length - 5} more transactions`);
    }
  }
}

/**
 * Get latest compression signatures (global)
 */
async function getLatestSignatures(rpc: Rpc): Promise<void> {
  console.log("\n--- Latest Compression Transactions ---");

  const result = await rpc.getLatestCompressionSignatures({ limit: 10 });

  console.log("Signatures found:", result.items.length);

  if (result.items.length > 0) {
    console.log("\nLatest:");
    for (const sig of result.items) {
      console.log(`  ${truncateAddress(sig.signature)} (slot: ${sig.slot})`);
    }
  }
}

/**
 * Get detailed transaction info
 */
async function getTransactionDetails(rpc: Rpc, signature: string): Promise<void> {
  console.log("\n--- Transaction Details ---");
  console.log("Signature:", truncateAddress(signature));

  const result = await rpc.getTransactionWithCompressionInfo(signature);

  if (result) {
    console.log("\nTransaction found:");
    console.log("  Slot:", result.slot);

    if (result.compressionInfo) {
      console.log("  Accounts opened:", result.compressionInfo.openedAccounts?.length || 0);
      console.log("  Accounts closed:", result.compressionInfo.closedAccounts?.length || 0);
    }
  } else {
    console.log("Transaction not found or not a compression transaction");
  }
}

/**
 * Check indexer health
 */
async function checkIndexerHealth(rpc: Rpc): Promise<void> {
  console.log("\n--- Indexer Health ---");

  try {
    const health = await rpc.getIndexerHealth();
    console.log("Status:", health.status || "healthy");
  } catch (error: any) {
    console.log("Status: unhealthy -", error.message);
  }

  try {
    const slot = await rpc.getIndexerSlot();
    console.log("Last indexed slot:", slot.slot);
  } catch (error: any) {
    console.log("Error getting slot:", error.message);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Query Compressed Accounts");
  console.log("=".repeat(60));

  // Setup
  const rpc = createRpc(CONFIG.RPC_ENDPOINT, CONFIG.RPC_ENDPOINT);

  // Determine owner to query
  let owner: PublicKey;
  if (CONFIG.OWNER_ADDRESS) {
    owner = new PublicKey(CONFIG.OWNER_ADDRESS);
  } else {
    const payer = loadKeypairFromEnv();
    owner = payer.publicKey;
  }

  console.log("\nQuerying for owner:", owner.toBase58());

  // Check indexer health first
  await checkIndexerHealth(rpc);

  // Query compressed accounts
  await getCompressedAccounts(rpc, owner);

  // Query token accounts
  const mint = CONFIG.MINT_ADDRESS ? new PublicKey(CONFIG.MINT_ADDRESS) : undefined;
  await getTokenAccounts(rpc, owner, mint);

  // Query token balances summary
  await getTokenBalances(rpc, owner);

  // Query transaction history
  await getTransactionHistory(rpc, owner);

  // Query latest global signatures
  await getLatestSignatures(rpc);

  // If we have mint, query holders
  if (mint) {
    await getMintHolders(rpc, mint);
  }

  console.log("\n" + "=".repeat(60));
  console.log("Query complete!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
