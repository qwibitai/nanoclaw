/**
 * Example Skill: Setup Template
 *
 * This template provides a ready-to-use setup for building applications.
 * Copy this file to your project and customize as needed.
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Update the CONFIG values
 * 3. Implement your custom logic in the client class
 * 4. Run with: npx ts-node setup.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Commitment,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// CONFIGURATION - Customize these values for your project
// ============================================================================

const CONFIG = {
  // RPC endpoint (use environment variable in production)
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Commitment level for transactions
  commitment: 'confirmed' as Commitment,

  // Path to wallet keypair file
  walletPath: process.env.WALLET_PATH || './keypair.json',

  // Your program ID (replace with actual)
  programId: new PublicKey('YourProgramId11111111111111111111111111111'),

  // Default transaction settings
  defaultComputeUnits: 200_000,
  defaultPriorityFee: 10_000, // microLamports
};

// ============================================================================
// TYPES - Define your custom types here
// ============================================================================

export interface ClientConfig {
  rpcUrl?: string;
  commitment?: Commitment;
  wallet?: Keypair;
}

export interface TransactionResult {
  signature: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Load wallet keypair from file
 */
function loadWallet(walletPath: string): Keypair {
  const resolvedPath = path.resolve(walletPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Wallet file not found: ${resolvedPath}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an operation with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ============================================================================
// CLIENT CLASS - Main interface for your protocol
// ============================================================================

export class ExampleClient {
  private connection: Connection;
  private wallet: Keypair;

  constructor(config: ClientConfig = {}) {
    this.connection = new Connection(
      config.rpcUrl || CONFIG.rpcUrl,
      config.commitment || CONFIG.commitment
    );
    this.wallet = config.wallet || loadWallet(CONFIG.walletPath);
  }

  // --------------------------------------------------------------------------
  // Public Properties
  // --------------------------------------------------------------------------

  get address(): PublicKey {
    return this.wallet.publicKey;
  }

  get rpc(): Connection {
    return this.connection;
  }

  // --------------------------------------------------------------------------
  // Core Methods - Implement your protocol logic here
  // --------------------------------------------------------------------------

  /**
   * Get SOL balance
   */
  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9; // Convert lamports to SOL
  }

  /**
   * Example method - replace with your protocol operations
   */
  async exampleOperation(param: string): Promise<TransactionResult> {
    console.log('Executing example operation with param:', param);

    // Build your transaction instructions here
    const instructions: TransactionInstruction[] = [];

    // Example: Add your program instruction
    // instructions.push(
    //   new TransactionInstruction({
    //     programId: CONFIG.programId,
    //     keys: [...],
    //     data: Buffer.from([...]),
    //   })
    // );

    if (instructions.length === 0) {
      return {
        signature: '',
        success: false,
        error: 'No instructions to execute (this is a template)',
      };
    }

    return await this.sendTransaction(instructions);
  }

  // --------------------------------------------------------------------------
  // Transaction Helpers
  // --------------------------------------------------------------------------

  /**
   * Send a transaction with retry logic
   */
  async sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[] = []
  ): Promise<TransactionResult> {
    try {
      const tx = new Transaction();
      tx.add(...instructions);

      tx.feePayer = this.wallet.publicKey;
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      const allSigners = [this.wallet, ...signers];

      const signature = await withRetry(() =>
        sendAndConfirmTransaction(
          this.connection,
          tx,
          allSigners,
          { commitment: CONFIG.commitment }
        )
      );

      return {
        signature,
        success: true,
      };
    } catch (error) {
      return {
        signature: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Simulate a transaction before sending
   */
  async simulateTransaction(
    instructions: TransactionInstruction[]
  ): Promise<{ success: boolean; logs: string[] }> {
    const tx = new Transaction();
    tx.add(...instructions);

    tx.feePayer = this.wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const simulation = await this.connection.simulateTransaction(tx);

    return {
      success: simulation.value.err === null,
      logs: simulation.value.logs || [],
    };
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log('=== Example Client Setup ===\n');

  // Initialize client
  const client = new ExampleClient();
  console.log('Wallet address:', client.address.toString());

  // Check balance
  const balance = await client.getBalance();
  console.log('SOL balance:', balance.toFixed(4), 'SOL');

  // Run example operation
  const result = await client.exampleOperation('test');
  console.log('\nOperation result:', result);

  console.log('\n=== Setup Complete ===');
  console.log('Customize this template for your specific protocol.');
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
