/**
 * Transaction Signing Example for Ranger Finance SOR
 *
 * Demonstrates the complete flow of:
 * 1. Getting a transaction from the SOR API
 * 2. Signing the transaction with a wallet
 * 3. Submitting the transaction to the Solana network
 */
import { SorApi, TradeSide, TransactionResponse } from 'ranger-sor-sdk';
import {
  Keypair,
  VersionedTransaction,
  Connection,
  TransactionMessage,
} from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const API_KEY = process.env.RANGER_API_KEY!;
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY!;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Initialize clients
const sorApi = new SorApi({
  apiKey: API_KEY,
  solanaRpcUrl: RPC_URL,
});

const connection = new Connection(RPC_URL, 'confirmed');

/**
 * Decode a base64 transaction message from the API
 */
function decodeTransaction(base64Message: string): VersionedTransaction {
  const buffer = Buffer.from(base64Message, 'base64');
  return VersionedTransaction.deserialize(buffer);
}

/**
 * Sign a transaction with a keypair
 */
function signTransaction(
  transaction: VersionedTransaction,
  keypair: Keypair
): VersionedTransaction {
  transaction.sign([keypair]);
  return transaction;
}

/**
 * Send a signed transaction and wait for confirmation
 */
async function sendAndConfirmTransaction(
  transaction: VersionedTransaction
): Promise<string> {
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  console.log('Transaction sent:', signature);
  console.log('Waiting for confirmation...');

  const latestBlockhash = await connection.getLatestBlockhash();

  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${confirmation.value.err}`);
  }

  console.log('Transaction confirmed!');
  return signature;
}

/**
 * Complete flow: Get transaction, sign, and execute
 */
async function executeCompleteTradeFlow() {
  if (!WALLET_PRIVATE_KEY) {
    console.log('WALLET_PRIVATE_KEY not set. Showing transaction preparation only.\n');

    // Just get the transaction without executing
    const txResponse = await sorApi.increasePosition({
      fee_payer: WALLET_PUBLIC_KEY,
      symbol: 'SOL',
      side: 'Long' as TradeSide,
      size: 0.1,
      collateral: 1.0,
      size_denomination: 'SOL',
      collateral_denomination: 'USDC',
      adjustment_type: 'Increase',
    });

    console.log('Transaction prepared successfully!');
    console.log('Message length:', txResponse.message.length, 'bytes (base64)');

    // Decode and inspect
    const tx = decodeTransaction(txResponse.message);
    console.log('Transaction version:', tx.version);
    console.log('Number of signatures required:', tx.message.header.numRequiredSignatures);

    return;
  }

  console.log('Executing complete trade flow...\n');

  try {
    // Step 1: Create keypair from private key
    console.log('Step 1: Loading wallet...');
    const privateKeyBytes = bs58.decode(WALLET_PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(privateKeyBytes);
    console.log('Wallet loaded:', keypair.publicKey.toString());

    // Step 2: Get transaction from SOR API
    console.log('\nStep 2: Getting transaction from SOR API...');
    const txResponse = await sorApi.increasePosition({
      fee_payer: keypair.publicKey.toString(),
      symbol: 'SOL',
      side: 'Long' as TradeSide,
      size: 0.1,
      collateral: 1.0,
      size_denomination: 'SOL',
      collateral_denomination: 'USDC',
      adjustment_type: 'Increase',
    });

    if (txResponse.meta) {
      console.log('Expected execution:', txResponse.meta);
    }

    // Step 3: Decode the transaction
    console.log('\nStep 3: Decoding transaction...');
    const transaction = decodeTransaction(txResponse.message);
    console.log('Transaction decoded successfully');

    // Step 4: Sign the transaction
    console.log('\nStep 4: Signing transaction...');
    const signedTransaction = signTransaction(transaction, keypair);
    console.log('Transaction signed');

    // Step 5: Send and confirm
    console.log('\nStep 5: Sending transaction...');
    const signature = await sendAndConfirmTransaction(signedTransaction);

    console.log('\n========================================');
    console.log('Trade executed successfully!');
    console.log('Signature:', signature);
    console.log('Explorer: https://solscan.io/tx/' + signature);
    console.log('========================================');

    return signature;
  } catch (error) {
    console.error('Error executing trade:', error);
    throw error;
  }
}

/**
 * Using the SDK's built-in executeTransaction method
 */
async function executeWithSdkHelper() {
  if (!WALLET_PRIVATE_KEY) {
    console.log('Skipping SDK helper example: No private key');
    return;
  }

  console.log('\nUsing SDK executeTransaction helper...\n');

  const privateKeyBytes = bs58.decode(WALLET_PRIVATE_KEY);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);

  // Get transaction
  const txResponse = await sorApi.increasePosition({
    fee_payer: keypair.publicKey.toString(),
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 0.1,
    collateral: 1.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase',
  });

  // Define signing function
  const signFn = async (tx: VersionedTransaction) => {
    tx.sign([keypair]);
    return tx;
  };

  // Execute using SDK helper
  const result = await sorApi.executeTransaction(txResponse, signFn);

  console.log('Trade executed via SDK helper!');
  console.log('Signature:', result.signature);

  return result;
}

/**
 * Simulate a transaction without executing
 */
async function simulateTransaction() {
  console.log('Simulating transaction...\n');

  // Get transaction
  const txResponse = await sorApi.increasePosition({
    fee_payer: WALLET_PUBLIC_KEY,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 0.1,
    collateral: 1.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase',
  });

  // Decode transaction
  const transaction = decodeTransaction(txResponse.message);

  // Simulate
  const simulation = await connection.simulateTransaction(transaction);

  console.log('Simulation Result:');
  console.log('==================');

  if (simulation.value.err) {
    console.log('Simulation FAILED');
    console.log('Error:', simulation.value.err);
  } else {
    console.log('Simulation SUCCESS');
    console.log('Compute units:', simulation.value.unitsConsumed);
  }

  if (simulation.value.logs) {
    console.log('\nLogs:');
    simulation.value.logs.forEach((log) => console.log('  ' + log));
  }

  return simulation;
}

/**
 * Main function
 */
async function main() {
  try {
    // Run simulation first
    await simulateTransaction();

    // Execute complete flow (with or without signing)
    await executeCompleteTradeFlow();

    console.log('\nExamples completed!');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
