/**
 * Lulo Full Integration Example
 *
 * This file demonstrates a complete integration with Lulo,
 * including deposits, withdrawals, balance queries, and monitoring.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  LULO_API_URL: 'https://api.lulo.fi',
  LULO_BLINK_URL: 'https://blink.lulo.fi',
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  API_KEY: process.env.LULO_API_KEY || '',
  DEFAULT_PRIORITY_FEE: 500000,
};

// Token mint addresses
const TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  USDS: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  SOL: 'So11111111111111111111111111111111111111112',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
} as const;

const TOKEN_DECIMALS: Record<string, number> = {
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
  [TOKENS.USDS]: 6,
  [TOKENS.SOL]: 9,
  [TOKENS.MSOL]: 9,
  [TOKENS.JITOSOL]: 9,
};

// ============================================================================
// Types
// ============================================================================

type DepositType = 'protected' | 'boosted' | 'regular';

interface LuloPosition {
  mint: string;
  symbol: string;
  depositType: DepositType;
  balance: number;
  interestEarned: number;
  apy: number;
  protocol?: string;
}

interface LuloAccount {
  totalDeposited: number;
  totalInterestEarned: number;
  currentApy: number;
  positions: LuloPosition[];
  rewards: Array<{
    mint: string;
    symbol: string;
    amount: number;
    claimable: boolean;
  }>;
}

interface LuloPool {
  mint: string;
  symbol: string;
  protectedApy: number;
  boostedApy: number;
  totalDeposited: number;
  availableCapacity: number;
}

interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
}

// ============================================================================
// Lulo Client Class
// ============================================================================

class LuloClient {
  private connection: Connection;
  private wallet: Keypair;
  private apiKey: string;

  constructor(connection: Connection, wallet: Keypair, apiKey: string) {
    this.connection = connection;
    this.wallet = wallet;
    this.apiKey = apiKey;
  }

  /**
   * Get wallet address
   */
  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  /**
   * Make authenticated API request
   */
  private async apiRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${CONFIG.LULO_API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`API Error: ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  /**
   * Sign and send a serialized transaction
   */
  private async signAndSend(serializedTx: string): Promise<string> {
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuffer);
    transaction.sign([this.wallet]);

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
  }

  // ========================================================================
  // Account Methods
  // ========================================================================

  /**
   * Get account data including balances and positions
   */
  async getAccount(): Promise<LuloAccount> {
    return this.apiRequest<LuloAccount>(`/v1/account/${this.walletAddress}`);
  }

  /**
   * Get account transaction history
   */
  async getHistory(limit: number = 50): Promise<any> {
    return this.apiRequest(`/v1/account/${this.walletAddress}/history?limit=${limit}`);
  }

  /**
   * Get pending withdrawals (for boosted deposits)
   */
  async getPendingWithdrawals(): Promise<any[]> {
    const data = await this.apiRequest<{ pendingWithdrawals: any[] }>(
      `/v1/account/${this.walletAddress}/pending-withdrawals`
    );
    return data.pendingWithdrawals || [];
  }

  // ========================================================================
  // Pool Methods
  // ========================================================================

  /**
   * Get all pool data and rates
   */
  async getPools(): Promise<LuloPool[]> {
    const data = await this.apiRequest<{ pools: LuloPool[] }>('/v1/pools');
    return data.pools;
  }

  /**
   * Get pool data for specific token
   */
  async getPool(mintAddress: string): Promise<LuloPool | null> {
    const pools = await this.getPools();
    return pools.find((p) => p.mint === mintAddress) || null;
  }

  // ========================================================================
  // Deposit Methods
  // ========================================================================

  /**
   * Deposit tokens into Lulo
   */
  async deposit(
    mintAddress: string,
    amount: number,
    depositType: DepositType = 'protected',
    priorityFee: number = CONFIG.DEFAULT_PRIORITY_FEE
  ): Promise<TransactionResult> {
    try {
      const data = await this.apiRequest<{ transaction: string }>(
        `/v1/generate.transactions.deposit?priorityFee=${priorityFee}`,
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

  /**
   * Deposit USDC (convenience method)
   */
  async depositUSDC(
    amount: number,
    depositType: DepositType = 'protected'
  ): Promise<TransactionResult> {
    const units = this.toUnits(amount, TOKENS.USDC);
    return this.deposit(TOKENS.USDC, units, depositType);
  }

  /**
   * Deposit SOL (convenience method)
   */
  async depositSOL(
    amount: number,
    depositType: DepositType = 'protected'
  ): Promise<TransactionResult> {
    const units = this.toUnits(amount, TOKENS.SOL);
    return this.deposit(TOKENS.SOL, units, depositType);
  }

  // ========================================================================
  // Withdrawal Methods
  // ========================================================================

  /**
   * Withdraw tokens from Lulo
   */
  async withdraw(
    mintAddress: string,
    amount: number,
    withdrawType: DepositType = 'protected',
    priorityFee: number = CONFIG.DEFAULT_PRIORITY_FEE
  ): Promise<TransactionResult> {
    try {
      const data = await this.apiRequest<{ transaction: string }>(
        `/v1/generate.transactions.withdraw?priorityFee=${priorityFee}`,
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

  /**
   * Withdraw USDC (convenience method)
   */
  async withdrawUSDC(
    amount: number,
    withdrawType: DepositType = 'protected'
  ): Promise<TransactionResult> {
    const units = this.toUnits(amount, TOKENS.USDC);
    return this.withdraw(TOKENS.USDC, units, withdrawType);
  }

  /**
   * Withdraw all from a position
   */
  async withdrawAll(
    mintAddress: string,
    depositType: DepositType
  ): Promise<TransactionResult> {
    const account = await this.getAccount();
    const position = account.positions.find(
      (p) => p.mint === mintAddress && p.depositType === depositType
    );

    if (!position || position.balance <= 0) {
      return { success: false, error: 'No position found' };
    }

    return this.withdraw(mintAddress, position.balance, depositType);
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Convert human-readable amount to token units
   */
  toUnits(amount: number, mint: string): number {
    const decimals = TOKEN_DECIMALS[mint] || 6;
    return Math.floor(amount * Math.pow(10, decimals));
  }

  /**
   * Convert token units to human-readable amount
   */
  fromUnits(units: number, mint: string): number {
    const decimals = TOKEN_DECIMALS[mint] || 6;
    return units / Math.pow(10, decimals);
  }

  /**
   * Get token balance in wallet
   */
  async getWalletBalance(mintAddress: string): Promise<number> {
    if (mintAddress === TOKENS.SOL) {
      return this.connection.getBalance(this.wallet.publicKey);
    }

    const accounts = await this.connection.getParsedTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint: new PublicKey(mintAddress) }
    );

    if (accounts.value.length === 0) return 0;
    return parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
  }

  /**
   * Get best APY across all pools for deposit type
   */
  async getBestRate(depositType: DepositType): Promise<{ pool: LuloPool; rate: number } | null> {
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
}

// ============================================================================
// Usage Examples
// ============================================================================

async function main() {
  // Initialize connection and wallet
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // Load wallet from environment (base58 secret key or JSON array)
  const secretKey = process.env.WALLET_SECRET_KEY;
  if (!secretKey) {
    console.error('Please set WALLET_SECRET_KEY environment variable');
    process.exit(1);
  }

  let wallet: Keypair;
  try {
    // Try parsing as JSON array first
    const keyArray = JSON.parse(secretKey);
    wallet = Keypair.fromSecretKey(new Uint8Array(keyArray));
  } catch {
    // Fall back to base58
    const { bs58 } = await import('bs58');
    wallet = Keypair.fromSecretKey(bs58.decode(secretKey));
  }

  // Create Lulo client
  const lulo = new LuloClient(connection, wallet, CONFIG.API_KEY);

  console.log('Wallet:', lulo.walletAddress);

  // ========================================================================
  // Example 1: Check Account Status
  // ========================================================================
  console.log('\n=== Account Status ===');
  const account = await lulo.getAccount();
  console.log(`Total Deposited: $${lulo.fromUnits(account.totalDeposited, TOKENS.USDC).toFixed(2)}`);
  console.log(`Interest Earned: $${lulo.fromUnits(account.totalInterestEarned, TOKENS.USDC).toFixed(2)}`);
  console.log(`Current APY: ${account.currentApy.toFixed(2)}%`);

  for (const position of account.positions) {
    console.log(
      `  ${position.symbol} (${position.depositType}): ${lulo.fromUnits(position.balance, position.mint).toFixed(2)} @ ${position.apy.toFixed(2)}%`
    );
  }

  // ========================================================================
  // Example 2: Check Current Rates
  // ========================================================================
  console.log('\n=== Current Rates ===');
  const pools = await lulo.getPools();
  for (const pool of pools) {
    console.log(
      `${pool.symbol}: Protected ${pool.protectedApy.toFixed(2)}% | Boosted ${pool.boostedApy.toFixed(2)}%`
    );
  }

  // ========================================================================
  // Example 3: Find Best Rate
  // ========================================================================
  console.log('\n=== Best Rates ===');
  const bestProtected = await lulo.getBestRate('protected');
  const bestBoosted = await lulo.getBestRate('boosted');

  if (bestProtected) {
    console.log(`Best Protected: ${bestProtected.pool.symbol} at ${bestProtected.rate.toFixed(2)}%`);
  }
  if (bestBoosted) {
    console.log(`Best Boosted: ${bestBoosted.pool.symbol} at ${bestBoosted.rate.toFixed(2)}%`);
  }

  // ========================================================================
  // Example 4: Deposit (uncomment to execute)
  // ========================================================================
  // console.log('\n=== Depositing 100 USDC ===');
  // const depositResult = await lulo.depositUSDC(100, 'protected');
  // if (depositResult.success) {
  //   console.log(`Deposit successful: ${depositResult.signature}`);
  // } else {
  //   console.error(`Deposit failed: ${depositResult.error}`);
  // }

  // ========================================================================
  // Example 5: Withdraw (uncomment to execute)
  // ========================================================================
  // console.log('\n=== Withdrawing 50 USDC ===');
  // const withdrawResult = await lulo.withdrawUSDC(50, 'protected');
  // if (withdrawResult.success) {
  //   console.log(`Withdrawal successful: ${withdrawResult.signature}`);
  // } else {
  //   console.error(`Withdrawal failed: ${withdrawResult.error}`);
  // }
}

// Run if executed directly
main().catch(console.error);

export { LuloClient, TOKENS, TOKEN_DECIMALS, CONFIG };
