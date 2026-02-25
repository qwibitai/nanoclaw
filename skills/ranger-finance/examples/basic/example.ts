/**
 * Basic Trading Example for Ranger Finance SOR
 *
 * Demonstrates how to get quotes, open positions, and execute trades
 * using the Ranger Smart Order Router.
 */
import { SorApi, OrderMetadataRequest, TradeSide } from 'ranger-sor-sdk';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const API_KEY = process.env.RANGER_API_KEY!;
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY!;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// Initialize the SOR API client
const sorApi = new SorApi({
  apiKey: API_KEY,
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
});

/**
 * Get a quote for a potential trade
 * This shows pricing across all available venues
 */
async function getTradeQuote() {
  console.log('Getting quote for 1 SOL Long position...\n');

  const request: OrderMetadataRequest = {
    fee_payer: WALLET_PUBLIC_KEY,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 1.0,
    collateral: 10.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Quote',
  };

  const quote = await sorApi.getOrderMetadata(request);

  console.log('Quote Results:');
  console.log('==============');

  quote.venues.forEach((venue) => {
    console.log(`\nVenue: ${venue.venue_name}`);
    console.log(`  Size: ${venue.size} SOL`);
    console.log(`  Collateral: ${venue.collateral} USDC`);
    console.log(`  Total Cost: ${venue.quote.total} USDC`);
    console.log(`  Fee Breakdown:`);
    console.log(`    - Base Fee: ${venue.quote.fee_breakdown.base_fee}`);
    console.log(`    - Spread Fee: ${venue.quote.fee_breakdown.spread_fee}`);
    console.log(`    - Volatility Fee: ${venue.quote.fee_breakdown.volatility_fee}`);
    console.log(`  Available Liquidity: ${venue.order_available_liquidity}`);
  });

  console.log(`\nTotal Size: ${quote.total_size} SOL`);
  console.log(`Total Collateral: ${quote.total_collateral} USDC`);

  return quote;
}

/**
 * Open a long position
 */
async function openLongPosition() {
  console.log('\nOpening Long Position...\n');

  const request = {
    fee_payer: WALLET_PUBLIC_KEY,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    size: 1.0,
    collateral: 10.0,
    size_denomination: 'SOL',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase' as const,
  };

  const response = await sorApi.increasePosition(request);

  console.log('Transaction prepared!');
  console.log('Message (base64):', response.message.substring(0, 50) + '...');

  if (response.meta) {
    console.log('\nExecution Details:');
    console.log(`  Price: ${response.meta.executed_price}`);
    console.log(`  Size: ${response.meta.executed_size}`);
    console.log(`  Collateral: ${response.meta.executed_collateral}`);
    console.log(`  Venues: ${response.meta.venues_used?.join(', ')}`);
  }

  return response;
}

/**
 * Open a short position
 */
async function openShortPosition() {
  console.log('\nOpening Short Position...\n');

  const request = {
    fee_payer: WALLET_PUBLIC_KEY,
    symbol: 'ETH',
    side: 'Short' as TradeSide,
    size: 0.5,
    collateral: 100.0,
    size_denomination: 'ETH',
    collateral_denomination: 'USDC',
    adjustment_type: 'Increase' as const,
  };

  const response = await sorApi.increasePosition(request);

  console.log('Short position transaction prepared!');

  return response;
}

/**
 * Close a position
 */
async function closePosition() {
  console.log('\nClosing Position...\n');

  const request = {
    fee_payer: WALLET_PUBLIC_KEY,
    symbol: 'SOL',
    side: 'Long' as TradeSide,
    adjustment_type: 'CloseAll' as const,
  };

  const response = await sorApi.closePosition(request);

  console.log('Close position transaction prepared!');

  return response;
}

/**
 * Execute a trade with transaction signing
 */
async function executeTradeWithSigning() {
  if (!WALLET_PRIVATE_KEY) {
    console.log('Skipping execution: No private key provided');
    return null;
  }

  console.log('\nExecuting trade with signing...\n');

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

  // Create keypair
  const privateKeyBytes = bs58.decode(WALLET_PRIVATE_KEY);
  const keypair = Keypair.fromSecretKey(privateKeyBytes);

  // Sign and execute
  const signTransaction = async (tx: VersionedTransaction) => {
    tx.sign([keypair]);
    return tx;
  };

  const result = await sorApi.executeTransaction(txResponse, signTransaction);

  console.log('Transaction executed!');
  console.log('Signature:', result.signature);

  return result;
}

/**
 * Main function to run examples
 */
async function main() {
  try {
    // Get a quote first
    await getTradeQuote();

    // Open a long position (get transaction, don't execute)
    await openLongPosition();

    // Optionally execute with signing
    // await executeTradeWithSigning();

    console.log('\nExamples completed successfully!');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
