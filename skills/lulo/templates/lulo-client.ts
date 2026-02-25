/**
 * Lulo Client Template
 *
 * A ready-to-use client for integrating Lulo into your Solana application.
 * Copy this file and configure the environment variables to get started.
 *
 * Required environment variables:
 * - LULO_API_KEY: Your Lulo API key from dev.lulo.fi
 * - RPC_URL: Solana RPC endpoint (optional, defaults to mainnet)
 * - WALLET_SECRET_KEY: Your wallet's secret key (JSON array or base58)
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  Commitment,
} from '@solana/web3.js';

// ============================================================================
// Configuration - Modify these values as needed
// ============================================================================

export const LULO_CONFIG = {
  // API endpoints
  API_URL: 'https://api.lulo.fi',
  BLINK_URL: 'https://blink.lulo.fi',
  DEVELOPER_PORTAL: 'https://dev.lulo.fi',

  // Default settings
  DEFAULT_PRIORITY_FEE: 500000, // microlamports
  DEFAULT_COMMITMENT: 'confirmed' as Commitment,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // ms
};

// Supported token mint addresses
export const LULO_TOKENS = {
  // Stablecoins
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  USDS: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',

  // Native
  SOL: 'So11111111111111111111111111111111111111112',

  // LSTs
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  BSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
} as const;

export const TOKEN_DECIMALS: Record<string, number> = {
  [LULO_TOKENS.USDC]: 6,
  [LULO_TOKENS.USDT]: 6,
  [LULO_TOKENS.USDS]: 6,
  [LULO_TOKENS.PYUSD]: 6,
  [LULO_TOKENS.SOL]: 9,
  [LULO_TOKENS.MSOL]: 9,
  [LULO_TOKENS.JITOSOL]: 9,
  [LULO_TOKENS.BSOL]: 9,
};

// ============================================================================
// Types
// ============================================================================

export type DepositType = 'protected' | 'boosted' | 'regular';

export interface LuloClientConfig {
  apiKey: string;
  rpcUrl?: string;
  commitment?: Commitment;
  priorityFee?: number;
}

export interface LuloPosition {
  mint: string;
  symbol: string;
  depositType: DepositType;
  balance: number;
  interestEarned: number;
  apy: number;
  protocol?: string;
}

export interface LuloAccount {
  totalDeposited: number;
  totalInterestEarned: number;
  currentApy: number;
  positions: LuloPosition[];
  rewards: LuloReward[];
}

export interface LuloReward {
  mint: string;
  symbol: string;
  amount: number;
  claimable: boolean;
}

export interface LuloPool {
  mint: string;
  symbol: string;
  decimals: number;
  protectedApy: number;
  boostedApy: number;
  customApy: number;
  totalDeposited: number;
  availableCapacity: number;
  coverageRatio: number;
}

export interface PendingWithdrawal {
  mint: string;
  amount: number;
  withdrawType: DepositType;
  initiatedAt: number;
  availableAt: number;
  cooldownRemaining: number;
}

export interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
}

// ============================================================================
// Lulo Client
// ============================================================================

export class LuloClient {
  private connection: Connection;
  private wallet: Keypair;
  private apiKey: string;
  private priorityFee: number;

  constructor(wallet: Keypair, config: LuloClientConfig) {
    this.wallet = wallet;
    this.apiKey = config.apiKey;
    this.priorityFee = config.priorityFee || LULO_CONFIG.DEFAULT_PRIORITY_FEE;
    this.connection = new Connection(
      config.rpcUrl || 'https://api.mainnet-beta.solana.com',
      config.commitment || LULO_CONFIG.DEFAULT_COMMITMENT
    );
  }

  // ========================================================================
  // Static Factory Methods
  // ========================================================================

  /**
   * Create client from environment variables
   */
  static fromEnv(): LuloClient {
    const apiKey = process.env.LULO_API_KEY;
    if (!apiKey) {
      throw new Error('LULO_API_KEY environment variable is required');
    }

    const secretKey = process.env.WALLET_SECRET_KEY;
    if (!secretKey) {
      throw new Error('WALLET_SECRET_KEY environment variable is required');
    }

    let wallet: Keypair;
    try {
      const keyArray = JSON.parse(secretKey);
      wallet = Keypair.fromSecretKey(new Uint8Array(keyArray));
    } catch {
      throw new Error('Invalid WALLET_SECRET_KEY format (expected JSON array)');
    }

    return new LuloClient(wallet, {
      apiKey,
      rpcUrl: process.env.RPC_URL,
    });
  }

  /**
   * Create client from keypair file
   */
  static fromKeypairFile(filePath: string, config: LuloClientConfig): LuloClient {
    const fs = require('fs');
    const keyData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(keyData));
    return new LuloClient(wallet, config);
  }

  // ========================================================================
  // Properties
  // ========================================================================

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  get publicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  // ========================================================================
  // API Methods
  // ========================================================================

  private async apiRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${LULO_CONFIG.API_URL}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`Lulo API Error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  private async signAndSend(
    serializedTx: string,
    retries: number = LULO_CONFIG.MAX_RETRIES
  ): Promise<string> {
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([this.wallet]);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const signature = await this.connection.sendTransaction(transaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        const latestBlockhash = await this.connection.getLatestBlockhash();
        await this.connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        });

        return signature;
      } catch (error) {
        lastError = error as Error;
        if (attempt < retries) {
          await this.sleep(LULO_CONFIG.RETRY_DELAY * attempt);
        }
      }
    }

    throw lastError || new Error('Transaction failed after all retries');
  }

  // ========================================================================
  // Account Methods
  // ========================================================================

  async getAccount(): Promise<LuloAccount> {
    return this.apiRequest<LuloAccount>(`/v1/account/${this.walletAddress}`);
  }

  async getHistory(limit: number = 50, offset: number = 0): Promise<any> {
    return this.apiRequest(`/v1/account/${this.walletAddress}/history?limit=${limit}&offset=${offset}`);
  }

  async getPendingWithdrawals(): Promise<PendingWithdrawal[]> {
    const data = await this.apiRequest<{ pendingWithdrawals: PendingWithdrawal[] }>(
      `/v1/account/${this.walletAddress}/pending-withdrawals`
    );
    return data.pendingWithdrawals || [];
  }

  // ========================================================================
  // Pool Methods
  // ========================================================================

  async getPools(): Promise<LuloPool[]> {
    const data = await this.apiRequest<{ pools: LuloPool[] }>('/v1/pools');
    return data.pools;
  }

  async getPool(mintAddress: string): Promise<LuloPool | undefined> {
    const pools = await this.getPools();
    return pools.find((p) => p.mint === mintAddress);
  }

  async getBestRate(
    depositType: 'protected' | 'boosted'
  ): Promise<{ pool: LuloPool; rate: number } | null> {
    const pools = await this.getPools();
    let best: { pool: LuloPool; rate: number } | null = null;

    for (const pool of pools) {
      const rate = depositType === 'protected' ? pool.protectedApy : pool.boostedApy;
      if (!best || rate > best.rate) {
        best = { pool, rate };
      }
    }

    return best;
  }

  // ========================================================================
  // Deposit Methods
  // ========================================================================

  async deposit(
    mintAddress: string,
    amount: number,
    depositType: DepositType = 'protected'
  ): Promise<TransactionResult> {
    try {
      const data = await this.apiRequest<{ transaction: string }>(
        `/v1/generate.transactions.deposit?priorityFee=${this.priorityFee}`,
        {
          method: 'POST',
          body: JSON.stringify({
            owner: this.walletAddress,
            mintAddress,
            depositType,
            amount,
          }),
        }
      );

      const signature = await this.signAndSend(data.transaction);
      return { success: true, signature };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async depositUSDC(amount: number, depositType: DepositType = 'protected'): Promise<TransactionResult> {
    return this.deposit(LULO_TOKENS.USDC, this.toUnits(amount, LULO_TOKENS.USDC), depositType);
  }

  async depositSOL(amount: number, depositType: DepositType = 'protected'): Promise<TransactionResult> {
    return this.deposit(LULO_TOKENS.SOL, this.toUnits(amount, LULO_TOKENS.SOL), depositType);
  }

  // ========================================================================
  // Withdrawal Methods
  // ========================================================================

  async withdraw(
    mintAddress: string,
    amount: number,
    withdrawType: DepositType = 'protected'
  ): Promise<TransactionResult> {
    try {
      const data = await this.apiRequest<{ transaction: string }>(
        `/v1/generate.transactions.withdraw?priorityFee=${this.priorityFee}`,
        {
          method: 'POST',
          body: JSON.stringify({
            owner: this.walletAddress,
            mintAddress,
            withdrawType,
            amount,
          }),
        }
      );

      const signature = await this.signAndSend(data.transaction);
      return { success: true, signature };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async withdrawUSDC(amount: number, withdrawType: DepositType = 'protected'): Promise<TransactionResult> {
    return this.withdraw(LULO_TOKENS.USDC, this.toUnits(amount, LULO_TOKENS.USDC), withdrawType);
  }

  async withdrawAll(mintAddress: string, depositType: DepositType): Promise<TransactionResult> {
    const account = await this.getAccount();
    const position = account.positions.find(
      (p) => p.mint === mintAddress && p.depositType === depositType
    );

    if (!position || position.balance <= 0) {
      return { success: false, error: 'No position found or balance is zero' };
    }

    return this.withdraw(mintAddress, position.balance, depositType);
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  toUnits(amount: number, mint: string): number {
    const decimals = TOKEN_DECIMALS[mint] || 6;
    return Math.floor(amount * Math.pow(10, decimals));
  }

  fromUnits(units: number, mint: string): number {
    const decimals = TOKEN_DECIMALS[mint] || 6;
    return units / Math.pow(10, decimals);
  }

  async getWalletBalance(mintAddress: string): Promise<number> {
    if (mintAddress === LULO_TOKENS.SOL) {
      return this.connection.getBalance(this.wallet.publicKey);
    }

    const accounts = await this.connection.getParsedTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint: new PublicKey(mintAddress) }
    );

    if (accounts.value.length === 0) return 0;
    return parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Quick Start Example
// ============================================================================

/*
// 1. Install dependencies:
//    npm install @solana/web3.js

// 2. Set environment variables:
//    export LULO_API_KEY="your-api-key"
//    export WALLET_SECRET_KEY="[1,2,3,...]"
//    export RPC_URL="https://api.mainnet-beta.solana.com" (optional)

// 3. Use the client:

import { LuloClient, LULO_TOKENS } from './lulo-client';

async function main() {
  // Create client from environment
  const lulo = LuloClient.fromEnv();

  // Get account info
  const account = await lulo.getAccount();
  console.log('Total deposited:', lulo.fromUnits(account.totalDeposited, LULO_TOKENS.USDC));

  // Get current rates
  const pools = await lulo.getPools();
  for (const pool of pools) {
    console.log(`${pool.symbol}: Protected ${pool.protectedApy}% | Boosted ${pool.boostedApy}%`);
  }

  // Deposit 100 USDC (protected)
  const depositResult = await lulo.depositUSDC(100, 'protected');
  console.log('Deposit:', depositResult);

  // Withdraw 50 USDC
  const withdrawResult = await lulo.withdrawUSDC(50, 'protected');
  console.log('Withdrawal:', withdrawResult);
}

main().catch(console.error);
*/

export default LuloClient;
