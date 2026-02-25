/**
 * Ranger Finance: Setup Template
 *
 * This template provides a ready-to-use setup for building applications
 * with the Ranger Finance Smart Order Router (SOR).
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Install dependencies: npm install @solana/web3.js bs58 dotenv
 * 3. Create .env file with RANGER_API_KEY and WALLET_PRIVATE_KEY
 * 4. Customize the RangerClient class for your needs
 * 5. Run with: npx ts-node setup.ts
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// CONFIGURATION - Customize these values for your project
// ============================================================================

const CONFIG = {
  // Ranger API key (required)
  apiKey: process.env.RANGER_API_KEY || '',

  // RPC endpoint
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Commitment level
  commitment: 'confirmed' as Commitment,

  // Ranger API endpoints
  sorApiBaseUrl: 'https://api.ranger.finance/v1',
  dataApiBaseUrl: 'https://data.ranger.finance/v1',

  // Wallet private key (base58 encoded)
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
};

// ============================================================================
// TYPES
// ============================================================================

export type TradeSide = 'Long' | 'Short';

export type AdjustmentType =
  | 'Quote'
  | 'Increase'
  | 'DecreaseFlash'
  | 'DecreaseJupiter'
  | 'DecreaseDrift'
  | 'DecreaseAdrena'
  | 'CloseFlash'
  | 'CloseJupiter'
  | 'CloseDrift'
  | 'CloseAdrena'
  | 'CloseAll';

export interface Position {
  id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  entry_price: number;
  liquidation_price: number;
  position_leverage: number;
  real_collateral: number;
  unrealized_pnl: number;
  platform: string;
}

export interface Quote {
  base: number;
  fee: number;
  total: number;
}

export interface VenueAllocation {
  venue_name: string;
  collateral: number;
  size: number;
  quote: Quote;
}

export interface OrderMetadataResponse {
  venues: VenueAllocation[];
  total_collateral: number;
  total_size: number;
}

export interface TransactionResponse {
  message: string;
  meta?: {
    executed_price?: number;
    executed_size?: number;
    venues_used?: string[];
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Load wallet keypair from base58 private key
 */
function loadWallet(privateKey: string): Keypair {
  if (!privateKey) {
    throw new Error('Wallet private key not provided');
  }
  const privateKeyBytes = bs58.decode(privateKey);
  return Keypair.fromSecretKey(privateKeyBytes);
}

/**
 * Decode a base64 transaction message
 */
function decodeTransaction(base64Message: string): VersionedTransaction {
  const buffer = Buffer.from(base64Message, 'base64');
  return VersionedTransaction.deserialize(buffer);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// RANGER CLIENT
// ============================================================================

export class RangerClient {
  private apiKey: string;
  private sorApiBaseUrl: string;
  private dataApiBaseUrl: string;
  private connection: Connection;
  private wallet: Keypair | null;

  constructor() {
    if (!CONFIG.apiKey) {
      throw new Error('RANGER_API_KEY is required');
    }

    this.apiKey = CONFIG.apiKey;
    this.sorApiBaseUrl = CONFIG.sorApiBaseUrl;
    this.dataApiBaseUrl = CONFIG.dataApiBaseUrl;
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);
    this.wallet = CONFIG.walletPrivateKey
      ? loadWallet(CONFIG.walletPrivateKey)
      : null;
  }

  // --------------------------------------------------------------------------
  // Public Properties
  // --------------------------------------------------------------------------

  get walletAddress(): string {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }
    return this.wallet.publicKey.toString();
  }

  get rpc(): Connection {
    return this.connection;
  }

  // --------------------------------------------------------------------------
  // API Methods
  // --------------------------------------------------------------------------

  /**
   * Make an authenticated API request
   */
  private async apiRequest<T>(
    baseUrl: string,
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: object
  ): Promise<T> {
    const url = `${baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || `API request failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get a quote for a potential trade
   */
  async getQuote(
    symbol: string,
    side: TradeSide,
    size: number,
    collateral: number
  ): Promise<OrderMetadataResponse> {
    return this.apiRequest<OrderMetadataResponse>(
      this.sorApiBaseUrl,
      '/order_metadata',
      'POST',
      {
        fee_payer: this.walletAddress,
        symbol,
        side,
        size,
        collateral,
        size_denomination: symbol,
        collateral_denomination: 'USDC',
        adjustment_type: 'Quote',
      }
    );
  }

  /**
   * Open or increase a position
   */
  async increasePosition(
    symbol: string,
    side: TradeSide,
    size: number,
    collateral: number
  ): Promise<TransactionResponse> {
    return this.apiRequest<TransactionResponse>(
      this.sorApiBaseUrl,
      '/increase_position',
      'POST',
      {
        fee_payer: this.walletAddress,
        symbol,
        side,
        size,
        collateral,
        size_denomination: symbol,
        collateral_denomination: 'USDC',
        adjustment_type: 'Increase',
      }
    );
  }

  /**
   * Close a position
   */
  async closePosition(
    symbol: string,
    side: TradeSide,
    adjustmentType: 'CloseFlash' | 'CloseJupiter' | 'CloseDrift' | 'CloseAdrena' | 'CloseAll' = 'CloseAll'
  ): Promise<TransactionResponse> {
    return this.apiRequest<TransactionResponse>(
      this.sorApiBaseUrl,
      '/close_position',
      'POST',
      {
        fee_payer: this.walletAddress,
        symbol,
        side,
        adjustment_type: adjustmentType,
      }
    );
  }

  /**
   * Get positions for the wallet
   */
  async getPositions(options?: {
    platforms?: string[];
    symbols?: string[];
  }): Promise<{ positions: Position[] }> {
    let endpoint = `/positions?public_key=${this.walletAddress}`;

    if (options?.platforms) {
      endpoint += `&platforms=${options.platforms.join(',')}`;
    }
    if (options?.symbols) {
      endpoint += `&symbols=${options.symbols.join(',')}`;
    }

    return this.apiRequest(this.dataApiBaseUrl, endpoint);
  }

  /**
   * Sign and execute a transaction
   */
  async executeTransaction(txResponse: TransactionResponse): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not configured for signing');
    }

    // Decode transaction
    const transaction = decodeTransaction(txResponse.message);

    // Sign
    transaction.sign([this.wallet]);

    // Send
    const signature = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: CONFIG.commitment,
    });

    // Confirm
    const latestBlockhash = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    return signature;
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log('=== Ranger Finance Setup ===\n');

  // Check configuration
  if (!CONFIG.apiKey) {
    console.log('Please set RANGER_API_KEY in your .env file');
    return;
  }

  // Initialize client
  const client = new RangerClient();

  if (CONFIG.walletPrivateKey) {
    console.log('Wallet address:', client.walletAddress);
  } else {
    console.log('No wallet configured (read-only mode)');
  }

  // Example: Get positions
  try {
    const positions = await client.getPositions();
    console.log(`\nPositions: ${positions.positions.length}`);

    positions.positions.forEach((pos) => {
      console.log(`  ${pos.symbol} ${pos.side}: ${pos.quantity} @ ${pos.entry_price}`);
    });
  } catch (error) {
    console.log('Could not fetch positions (need valid wallet)');
  }

  // Example: Get a quote (requires wallet)
  if (CONFIG.walletPrivateKey) {
    try {
      const quote = await client.getQuote('SOL', 'Long', 0.1, 1.0);
      console.log('\nQuote for 0.1 SOL Long:');
      quote.venues.forEach((v) => {
        console.log(`  ${v.venue_name}: $${v.quote.total.toFixed(2)}`);
      });
    } catch (error) {
      console.log('Could not get quote:', error);
    }
  }

  console.log('\n=== Setup Complete ===');
  console.log('Customize this template for your trading application.');
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
