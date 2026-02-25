/**
 * Surfpool Cheatcodes Example
 *
 * This example demonstrates how to use Surfpool cheatcodes for:
 * - Setting account state
 * - Manipulating token accounts
 * - Time travel
 * - Network control
 * - Transaction profiling
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcEndpoint: process.env.SURFPOOL_RPC || "http://127.0.0.1:8899",

  // Known mainnet addresses
  USDC_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT_MINT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
};

// ============================================================================
// CHEATCODE WRAPPERS
// ============================================================================

/**
 * Call a Surfnet cheatcode RPC method
 */
async function callCheatcode(
  connection: Connection,
  method: string,
  params: any[] = []
): Promise<any> {
  // @ts-ignore - Custom RPC method
  const result = await connection._rpcRequest(method, params);

  if (result.error) {
    throw new Error(`Cheatcode error: ${result.error.message}`);
  }

  return result.result;
}

// ============================================================================
// ACCOUNT MANIPULATION
// ============================================================================

/**
 * Set arbitrary account data
 */
async function setAccount(
  connection: Connection,
  pubkey: PublicKey,
  options: {
    lamports?: number;
    data?: Buffer;
    owner?: PublicKey;
    executable?: boolean;
  }
): Promise<void> {
  await callCheatcode(connection, "surfnet_setAccount", [
    {
      pubkey: pubkey.toBase58(),
      lamports: options.lamports,
      data: options.data?.toString("base64"),
      owner: options.owner?.toBase58(),
      executable: options.executable,
    },
  ]);

  console.log(`Set account ${pubkey.toBase58().slice(0, 8)}...`);
}

/**
 * Set token account balance
 */
async function setTokenAccount(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: bigint,
  options?: {
    tokenProgram?: PublicKey;
    delegate?: PublicKey;
  }
): Promise<void> {
  await callCheatcode(connection, "surfnet_setTokenAccount", [
    {
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: (options?.tokenProgram || TOKEN_PROGRAM_ID).toBase58(),
      update: {
        amount: amount.toString(),
        delegate: options?.delegate?.toBase58(),
      },
    },
  ]);

  console.log(
    `Set token balance for ${owner.toBase58().slice(0, 8)}...: ${amount}`
  );
}

/**
 * Clone a program from mainnet
 */
async function cloneProgram(
  connection: Connection,
  source: PublicKey,
  destination?: PublicKey
): Promise<void> {
  await callCheatcode(connection, "surfnet_cloneProgramAccount", [
    {
      source: source.toBase58(),
      destination: destination?.toBase58() || source.toBase58(),
    },
  ]);

  console.log(`Cloned program ${source.toBase58().slice(0, 8)}...`);
}

/**
 * Reset account to mainnet state
 */
async function resetAccount(
  connection: Connection,
  pubkey: PublicKey,
  includeOwnedAccounts = false
): Promise<void> {
  await callCheatcode(connection, "surfnet_resetAccount", [
    {
      pubkey: pubkey.toBase58(),
      includeOwnedAccounts,
    },
  ]);

  console.log(`Reset account ${pubkey.toBase58().slice(0, 8)}...`);
}

// ============================================================================
// TIME CONTROL
// ============================================================================

/**
 * Time travel to specific slot/epoch
 */
async function timeTravel(
  connection: Connection,
  options: {
    slot?: number;
    epoch?: number;
    timestamp?: number;
  }
): Promise<void> {
  await callCheatcode(connection, "surfnet_timeTravel", [options]);
  console.log("Time traveled to:", options);
}

/**
 * Pause block production
 */
async function pauseClock(connection: Connection): Promise<void> {
  await callCheatcode(connection, "surfnet_pauseClock", []);
  console.log("Clock paused");
}

/**
 * Resume block production
 */
async function resumeClock(connection: Connection): Promise<void> {
  await callCheatcode(connection, "surfnet_resumeClock", []);
  console.log("Clock resumed");
}

/**
 * Advance clock by slots
 */
async function advanceClock(
  connection: Connection,
  slots: number
): Promise<void> {
  await callCheatcode(connection, "surfnet_advanceClock", [{ slots }]);
  console.log(`Advanced clock by ${slots} slots`);
}

/**
 * Get current clock
 */
async function getClock(connection: Connection): Promise<{
  epoch: number;
  slot: number;
  timestamp: number;
}> {
  return await callCheatcode(connection, "surfnet_getClock", []);
}

// ============================================================================
// NETWORK CONTROL
// ============================================================================

/**
 * Reset network to initial state
 */
async function resetNetwork(connection: Connection): Promise<void> {
  await callCheatcode(connection, "surfnet_resetNetwork", []);
  console.log("Network reset");
}

/**
 * Get Surfpool version
 */
async function getVersion(connection: Connection): Promise<any> {
  return await callCheatcode(connection, "surfnet_getSurfpoolVersion", []);
}

// ============================================================================
// TRANSACTION PROFILING
// ============================================================================

/**
 * Profile a transaction
 */
async function profileTransaction(
  connection: Connection,
  transaction: string, // base64 encoded
  tag?: string
): Promise<any> {
  return await callCheatcode(connection, "surfnet_profileTransaction", [
    {
      transaction,
      tag,
    },
  ]);
}

/**
 * Get profile results by tag
 */
async function getProfileResults(
  connection: Connection,
  tag: string
): Promise<any[]> {
  return await callCheatcode(connection, "surfnet_getProfileResults", [
    { tag },
  ]);
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Surfpool Cheatcodes Example");
  console.log("=".repeat(60));

  const connection = new Connection(CONFIG.rpcEndpoint, "confirmed");

  // Check connection
  try {
    const version = await getVersion(connection);
    console.log("\nSurfpool Version:", version);
  } catch (e) {
    console.error("Failed to connect to Surfnet. Is it running?");
    console.log("Start with: surfpool start");
    process.exit(1);
  }

  // Create test wallet
  const wallet = Keypair.generate();
  console.log("\nTest wallet:", wallet.publicKey.toBase58());

  // -------------------------------------------------------------------------
  // Account Manipulation
  // -------------------------------------------------------------------------
  console.log("\n--- Account Manipulation ---");

  // Set SOL balance directly (no airdrop needed!)
  await setAccount(connection, wallet.publicKey, {
    lamports: 100 * LAMPORTS_PER_SOL,
  });

  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Balance after setAccount:", balance / LAMPORTS_PER_SOL, "SOL");

  // Set token account balance (create USDC out of thin air)
  await setTokenAccount(
    connection,
    wallet.publicKey,
    CONFIG.USDC_MINT,
    BigInt(1000_000_000) // 1000 USDC (6 decimals)
  );

  console.log("Set 1000 USDC balance for wallet");

  // -------------------------------------------------------------------------
  // Time Control
  // -------------------------------------------------------------------------
  console.log("\n--- Time Control ---");

  // Get current clock
  const clockBefore = await getClock(connection);
  console.log("Current slot:", clockBefore.slot);

  // Advance 100 slots
  await advanceClock(connection, 100);

  const clockAfter = await getClock(connection);
  console.log("After advance:", clockAfter.slot);

  // Time travel to future
  await timeTravel(connection, {
    slot: clockAfter.slot + 1000,
  });

  const clockFuture = await getClock(connection);
  console.log("After time travel:", clockFuture.slot);

  // Pause and resume
  console.log("\nPausing clock...");
  await pauseClock(connection);

  // Clock is paused, slots won't advance automatically
  await new Promise((r) => setTimeout(r, 2000));

  const clockPaused = await getClock(connection);
  console.log("Slot while paused:", clockPaused.slot);

  console.log("Resuming clock...");
  await resumeClock(connection);

  // -------------------------------------------------------------------------
  // Network Reset
  // -------------------------------------------------------------------------
  console.log("\n--- Network Control ---");

  console.log("Resetting network to initial state...");
  await resetNetwork(connection);

  // Balance should be 0 after reset
  const balanceAfterReset = await connection.getBalance(wallet.publicKey);
  console.log("Balance after reset:", balanceAfterReset / LAMPORTS_PER_SOL, "SOL");

  console.log("\n" + "=".repeat(60));
  console.log("Cheatcodes Example Complete!");
  console.log("=".repeat(60));
}

// Run
main().catch(console.error);

// Export for use in other examples
export {
  callCheatcode,
  setAccount,
  setTokenAccount,
  cloneProgram,
  resetAccount,
  timeTravel,
  pauseClock,
  resumeClock,
  advanceClock,
  getClock,
  resetNetwork,
  getVersion,
  profileTransaction,
  getProfileResults,
};
