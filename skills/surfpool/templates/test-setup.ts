/**
 * Surfpool Test Setup Template
 *
 * A comprehensive template for setting up tests with Surfpool.
 * Includes utilities for cheatcodes, state management, and assertions.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

// ============================================================================
// CONFIGURATION
// ============================================================================

export const CONFIG = {
  // Surfnet endpoints
  rpcEndpoint: process.env.SURFPOOL_RPC || "http://127.0.0.1:8899",
  wsEndpoint: process.env.SURFPOOL_WS || "ws://127.0.0.1:8900",
  studioUrl: "http://127.0.0.1:18488",

  // Common token mints (mainnet addresses work on Surfnet)
  tokens: {
    USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    USDT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    SOL: new PublicKey("So11111111111111111111111111111111111111112"),
  },

  // Default test amounts
  defaultSolAirdrop: 100 * LAMPORTS_PER_SOL,
  defaultTokenAmount: BigInt(1000_000_000), // 1000 tokens (6 decimals)
};

// ============================================================================
// SURFPOOL TEST CONTEXT
// ============================================================================

export class SurfpoolTestContext {
  public connection: Connection;
  public wallets: Map<string, Keypair> = new Map();

  constructor(rpcEndpoint?: string) {
    this.connection = new Connection(
      rpcEndpoint || CONFIG.rpcEndpoint,
      "confirmed"
    );
  }

  // --------------------------------------------------------------------------
  // Cheatcode Helpers
  // --------------------------------------------------------------------------

  /**
   * Call a Surfnet cheatcode
   */
  async cheatcode(method: string, params: any[] = []): Promise<any> {
    // @ts-ignore
    const result = await this.connection._rpcRequest(method, params);
    if (result.error) {
      throw new Error(`Cheatcode ${method} failed: ${result.error.message}`);
    }
    return result.result;
  }

  /**
   * Set SOL balance for an account
   */
  async setSolBalance(pubkey: PublicKey, lamports: number): Promise<void> {
    await this.cheatcode("surfnet_setAccount", [
      {
        pubkey: pubkey.toBase58(),
        lamports,
      },
    ]);
  }

  /**
   * Set token balance for an account
   */
  async setTokenBalance(
    owner: PublicKey,
    mint: PublicKey,
    amount: bigint
  ): Promise<void> {
    await this.cheatcode("surfnet_setTokenAccount", [
      {
        owner: owner.toBase58(),
        mint: mint.toBase58(),
        update: { amount: amount.toString() },
      },
    ]);
  }

  /**
   * Time travel to specific slot
   */
  async timeTravel(options: { slot?: number; timestamp?: number }): Promise<void> {
    await this.cheatcode("surfnet_timeTravel", [options]);
  }

  /**
   * Advance clock by slots
   */
  async advanceClock(slots: number): Promise<void> {
    await this.cheatcode("surfnet_advanceClock", [{ slots }]);
  }

  /**
   * Reset network state
   */
  async resetNetwork(): Promise<void> {
    await this.cheatcode("surfnet_resetNetwork", []);
  }

  /**
   * Get current clock
   */
  async getClock(): Promise<{ slot: number; epoch: number; timestamp: number }> {
    return await this.cheatcode("surfnet_getClock", []);
  }

  // --------------------------------------------------------------------------
  // Wallet Management
  // --------------------------------------------------------------------------

  /**
   * Create and fund a test wallet
   */
  async createWallet(
    name: string,
    solAmount: number = CONFIG.defaultSolAirdrop
  ): Promise<Keypair> {
    const wallet = Keypair.generate();
    this.wallets.set(name, wallet);

    // Fund with SOL
    await this.setSolBalance(wallet.publicKey, solAmount);

    return wallet;
  }

  /**
   * Get a named wallet
   */
  getWallet(name: string): Keypair {
    const wallet = this.wallets.get(name);
    if (!wallet) {
      throw new Error(`Wallet "${name}" not found`);
    }
    return wallet;
  }

  /**
   * Fund wallet with tokens
   */
  async fundWithTokens(
    wallet: Keypair,
    mint: PublicKey,
    amount: bigint
  ): Promise<void> {
    await this.setTokenBalance(wallet.publicKey, mint, amount);
  }

  // --------------------------------------------------------------------------
  // State Helpers
  // --------------------------------------------------------------------------

  /**
   * Get SOL balance
   */
  async getBalance(pubkey: PublicKey): Promise<number> {
    return await this.connection.getBalance(pubkey);
  }

  /**
   * Get token balance
   */
  async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      const account = await this.connection.getTokenAccountBalance(ata);
      return BigInt(account.value.amount);
    } catch {
      return BigInt(0);
    }
  }

  // --------------------------------------------------------------------------
  // Transaction Helpers
  // --------------------------------------------------------------------------

  /**
   * Send and confirm a transaction
   */
  async sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[]
  ): Promise<string> {
    const transaction = new Transaction().add(...instructions);
    return await sendAndConfirmTransaction(
      this.connection,
      transaction,
      signers
    );
  }

  /**
   * Profile a transaction
   */
  async profileTransaction(
    transaction: Transaction,
    tag?: string
  ): Promise<any> {
    const serialized = transaction
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    return await this.cheatcode("surfnet_profileTransaction", [
      { transaction: serialized, tag },
    ]);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Wait for Surfnet to be ready
   */
  async waitForReady(maxAttempts = 30): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.connection.getVersion();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return false;
  }

  /**
   * Clean up after tests
   */
  async cleanup(): Promise<void> {
    await this.resetNetwork();
    this.wallets.clear();
  }
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Assert helper
 */
export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Assert balance
 */
export async function assertBalance(
  ctx: SurfpoolTestContext,
  pubkey: PublicKey,
  expected: number,
  tolerance: number = 0
): Promise<void> {
  const actual = await ctx.getBalance(pubkey);
  const diff = Math.abs(actual - expected);
  assert(
    diff <= tolerance,
    `Balance mismatch: expected ${expected}, got ${actual}`
  );
}

/**
 * Assert token balance
 */
export async function assertTokenBalance(
  ctx: SurfpoolTestContext,
  owner: PublicKey,
  mint: PublicKey,
  expected: bigint
): Promise<void> {
  const actual = await ctx.getTokenBalance(owner, mint);
  assert(
    actual === expected,
    `Token balance mismatch: expected ${expected}, got ${actual}`
  );
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function exampleTest() {
  // Create test context
  const ctx = new SurfpoolTestContext();

  // Wait for Surfnet
  const ready = await ctx.waitForReady();
  if (!ready) {
    console.error("Surfnet not ready. Run: surfpool start");
    process.exit(1);
  }

  console.log("Running example test...\n");

  try {
    // Setup: Create wallets
    const alice = await ctx.createWallet("alice", 100 * LAMPORTS_PER_SOL);
    const bob = await ctx.createWallet("bob", 10 * LAMPORTS_PER_SOL);

    console.log("Alice:", alice.publicKey.toBase58());
    console.log("Bob:", bob.publicKey.toBase58());

    // Setup: Fund with tokens
    await ctx.fundWithTokens(alice, CONFIG.tokens.USDC, BigInt(1000_000_000));

    // Verify setup
    await assertBalance(ctx, alice.publicKey, 100 * LAMPORTS_PER_SOL);
    await assertTokenBalance(
      ctx,
      alice.publicKey,
      CONFIG.tokens.USDC,
      BigInt(1000_000_000)
    );

    console.log("\nSetup verified!");

    // Test: Time manipulation
    const clockBefore = await ctx.getClock();
    await ctx.advanceClock(100);
    const clockAfter = await ctx.getClock();

    assert(
      clockAfter.slot > clockBefore.slot,
      "Clock should have advanced"
    );

    console.log("Time manipulation verified!");

    // Cleanup
    await ctx.cleanup();

    console.log("\nTest passed!");
  } catch (error) {
    console.error("Test failed:", error);
    await ctx.cleanup();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  exampleTest().catch(console.error);
}

// Export for use in test files
export { exampleTest };
