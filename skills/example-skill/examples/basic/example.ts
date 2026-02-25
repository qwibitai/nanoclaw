/**
 * Example Skill: Basic Usage Example
 *
 * This file demonstrates the format for code examples in skills.
 * Examples should be complete, runnable, and well-documented.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC endpoint - use environment variable or default
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Wallet path
  walletPath: process.env.WALLET_PATH || './keypair.json',

  // Program ID (replace with actual program ID)
  programId: new PublicKey('ExampleProgram111111111111111111111111111'),
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Load a wallet keypair from a JSON file
 */
function loadWallet(path: string): Keypair {
  if (!fs.existsSync(path)) {
    throw new Error(`Wallet file not found: ${path}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

/**
 * Format a public key for display (truncated)
 */
function formatAddress(address: PublicKey): string {
  const str = address.toString();
  return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

/**
 * Format lamports as SOL
 */
function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(4);
}

// ============================================================================
// MAIN EXAMPLE FUNCTIONS
// ============================================================================

/**
 * Example 1: Basic connection and balance check
 */
async function checkBalance(connection: Connection, address: PublicKey): Promise<void> {
  console.log('\n=== Checking Balance ===');
  console.log('Address:', address.toString());

  const balance = await connection.getBalance(address);
  console.log('Balance:', lamportsToSol(balance), 'SOL');
}

/**
 * Example 2: Fetch account info
 */
async function getAccountInfo(
  connection: Connection,
  address: PublicKey
): Promise<void> {
  console.log('\n=== Getting Account Info ===');
  console.log('Address:', formatAddress(address));

  const accountInfo = await connection.getAccountInfo(address);

  if (!accountInfo) {
    console.log('Account does not exist');
    return;
  }

  console.log('Owner:', accountInfo.owner.toString());
  console.log('Lamports:', accountInfo.lamports);
  console.log('Data length:', accountInfo.data.length, 'bytes');
  console.log('Executable:', accountInfo.executable);
}

/**
 * Example 3: Get recent blockhash
 */
async function getRecentBlockhash(connection: Connection): Promise<string> {
  console.log('\n=== Getting Recent Blockhash ===');

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  console.log('Blockhash:', blockhash);
  console.log('Last valid block height:', lastValidBlockHeight);

  return blockhash;
}

// ============================================================================
// ERROR HANDLING EXAMPLE
// ============================================================================

/**
 * Example of proper error handling
 */
async function safeOperation<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    console.error(errorMessage);

    if (error instanceof Error) {
      console.error('Error:', error.message);
    }

    return null;
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main() {
  console.log('=== Example Skill Demo ===');

  // Setup connection
  const connection = new Connection(CONFIG.rpcUrl, 'confirmed');
  console.log('Connected to:', CONFIG.rpcUrl);

  // Load wallet (with error handling)
  let wallet: Keypair;
  try {
    wallet = loadWallet(CONFIG.walletPath);
    console.log('Wallet loaded:', formatAddress(wallet.publicKey));
  } catch (error) {
    console.log('No wallet file found, using random keypair for demo');
    wallet = Keypair.generate();
  }

  // Run examples
  await checkBalance(connection, wallet.publicKey);
  await getAccountInfo(connection, wallet.publicKey);
  await getRecentBlockhash(connection);

  // Example with error handling
  const result = await safeOperation(
    () => connection.getBalance(wallet.publicKey),
    'Failed to get balance'
  );

  if (result !== null) {
    console.log('\nSafe operation result:', lamportsToSol(result), 'SOL');
  }

  console.log('\n=== Demo Complete ===');
}

// Run the example
main().catch(console.error);
