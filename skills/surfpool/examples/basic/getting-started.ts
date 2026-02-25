/**
 * Surfpool Getting Started Example
 *
 * This example demonstrates basic Surfpool usage including:
 * - Connecting to local Surfnet
 * - Sending transactions
 * - Using the faucet
 * - Reading account data
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Surfnet RPC endpoint (default port)
  rpcEndpoint: process.env.SURFPOOL_RPC || "http://127.0.0.1:8899",

  // Surfpool Studio URL
  studioUrl: "http://127.0.0.1:18488",

  // WebSocket endpoint
  wsEndpoint: process.env.SURFPOOL_WS || "ws://127.0.0.1:8900",
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Wait for Surfnet to be ready
 */
async function waitForSurfnet(
  connection: Connection,
  maxAttempts = 30
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const version = await connection.getVersion();
      console.log("Surfnet ready! Version:", version["solana-core"]);
      return true;
    } catch {
      console.log(`Waiting for Surfnet... (${i + 1}/${maxAttempts})`);
      await sleep(1000);
    }
  }
  return false;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format SOL amount
 */
function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
}

// ============================================================================
// SURFNET OPERATIONS
// ============================================================================

/**
 * Request airdrop from Surfnet faucet
 */
async function requestAirdrop(
  connection: Connection,
  pubkey: PublicKey,
  amount: number = 10 * LAMPORTS_PER_SOL
): Promise<string> {
  console.log(`Requesting airdrop of ${formatSol(amount)} to ${pubkey.toBase58()}`);

  const signature = await connection.requestAirdrop(pubkey, amount);
  await connection.confirmTransaction(signature);

  console.log("Airdrop confirmed:", signature);
  return signature;
}

/**
 * Get account balance
 */
async function getBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const balance = await connection.getBalance(pubkey);
  return balance;
}

/**
 * Send SOL transfer
 */
async function sendSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  amount: number
): Promise<string> {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: amount,
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    from,
  ]);

  return signature;
}

/**
 * Get Surfnet clock using cheatcode
 */
async function getSurfnetClock(connection: Connection): Promise<any> {
  // @ts-ignore - Custom RPC method
  const result = await connection._rpcRequest("surfnet_getClock", []);
  return result.result;
}

/**
 * Get Surfpool version using cheatcode
 */
async function getSurfpoolVersion(connection: Connection): Promise<any> {
  // @ts-ignore - Custom RPC method
  const result = await connection._rpcRequest("surfnet_getSurfpoolVersion", []);
  return result.result;
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Surfpool Getting Started Example");
  console.log("=".repeat(60));

  // Create connection
  const connection = new Connection(CONFIG.rpcEndpoint, "confirmed");
  console.log("\nConnecting to:", CONFIG.rpcEndpoint);

  // Wait for Surfnet to be ready
  const ready = await waitForSurfnet(connection);
  if (!ready) {
    console.error("Failed to connect to Surfnet. Is it running?");
    console.log("\nStart Surfpool with: surfpool start");
    process.exit(1);
  }

  // Get Surfpool version
  try {
    const version = await getSurfpoolVersion(connection);
    console.log("\nSurfpool Version:", version);
  } catch (e) {
    console.log("Could not get Surfpool version (cheatcode may not be available)");
  }

  // Create test keypairs
  const sender = Keypair.generate();
  const receiver = Keypair.generate();

  console.log("\n--- Keypairs ---");
  console.log("Sender:", sender.publicKey.toBase58());
  console.log("Receiver:", receiver.publicKey.toBase58());

  // Request airdrop
  console.log("\n--- Airdrop ---");
  await requestAirdrop(connection, sender.publicKey, 10 * LAMPORTS_PER_SOL);

  // Check balance
  const senderBalance = await getBalance(connection, sender.publicKey);
  console.log("Sender balance:", formatSol(senderBalance));

  // Send SOL
  console.log("\n--- Transfer ---");
  const transferAmount = 1 * LAMPORTS_PER_SOL;
  console.log(`Sending ${formatSol(transferAmount)} to receiver...`);

  const signature = await sendSol(
    connection,
    sender,
    receiver.publicKey,
    transferAmount
  );
  console.log("Transfer signature:", signature);

  // Check final balances
  console.log("\n--- Final Balances ---");
  const finalSenderBalance = await getBalance(connection, sender.publicKey);
  const finalReceiverBalance = await getBalance(connection, receiver.publicKey);

  console.log("Sender:", formatSol(finalSenderBalance));
  console.log("Receiver:", formatSol(finalReceiverBalance));

  // Get network clock
  try {
    console.log("\n--- Network Clock ---");
    const clock = await getSurfnetClock(connection);
    console.log("Slot:", clock.slot);
    console.log("Epoch:", clock.epoch);
  } catch (e) {
    // Cheatcode may not be available
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Example Complete!");
  console.log("=".repeat(60));
  console.log("\nSurfpool Studio:", CONFIG.studioUrl);
  console.log("View your transactions and accounts in the dashboard.");
}

// Run
main().catch(console.error);

// Export for use in other examples
export {
  CONFIG,
  waitForSurfnet,
  requestAirdrop,
  getBalance,
  sendSol,
  getSurfnetClock,
  getSurfpoolVersion,
};
