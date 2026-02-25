// Raydium SDK Setup Template
// Copy this file and customize for your project

import { Raydium, TxVersion } from '@raydium-io/raydium-sdk-v2';
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import Decimal from 'decimal.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Network
  CLUSTER: 'mainnet' as const, // 'mainnet' | 'devnet'

  // RPC - Replace with your own for production
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Wallet - Load from environment or file
  WALLET_SECRET: process.env.WALLET_SECRET || '',

  // Transaction settings
  TX_VERSION: 'V0' as TxVersion, // 'V0' | 'LEGACY'
  COMMITMENT: 'confirmed' as const,

  // Default compute budget
  COMPUTE_UNITS: 600000,
  PRIORITY_FEE: 50000, // microLamports
};

// =============================================================================
// RAYDIUM CLIENT
// =============================================================================

export class RaydiumClient {
  private raydium: Raydium | null = null;
  private connection: Connection;
  private owner: Keypair;

  constructor() {
    // Validate config
    if (!CONFIG.WALLET_SECRET) {
      throw new Error('WALLET_SECRET not configured');
    }

    // Setup connection
    this.connection = new Connection(CONFIG.RPC_URL, {
      commitment: CONFIG.COMMITMENT,
    });

    // Load wallet
    this.owner = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_SECRET));

    console.log('Wallet:', this.owner.publicKey.toBase58());
    console.log('Cluster:', CONFIG.CLUSTER);
  }

  // Initialize SDK
  async init(): Promise<Raydium> {
    if (this.raydium) {
      return this.raydium;
    }

    console.log('Initializing Raydium SDK...');

    this.raydium = await Raydium.load({
      connection: this.connection,
      owner: this.owner,
      cluster: CONFIG.CLUSTER,
      disableLoadToken: false,
    });

    console.log('SDK initialized');
    return this.raydium;
  }

  // Get SDK instance
  get sdk(): Raydium {
    if (!this.raydium) {
      throw new Error('SDK not initialized - call init() first');
    }
    return this.raydium;
  }

  // Get connection
  get conn(): Connection {
    return this.connection;
  }

  // Get wallet
  get wallet(): Keypair {
    return this.owner;
  }

  // ==========================================================================
  // SWAP METHODS
  // ==========================================================================

  async swapCpmm(params: {
    poolId: string;
    inputMint: string;
    amount: number | string | BN;
    slippage?: number;
  }) {
    const raydium = await this.init();

    const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(params.poolId);

    const inputAmount =
      params.amount instanceof BN
        ? params.amount
        : new BN(params.amount.toString());

    const { execute, extInfo } = await raydium.cpmm.swap({
      poolInfo,
      inputAmount,
      inputMint: params.inputMint,
      slippage: params.slippage ?? 0.01,
      txVersion: CONFIG.TX_VERSION,
      computeBudgetConfig: {
        units: CONFIG.COMPUTE_UNITS,
        microLamports: CONFIG.PRIORITY_FEE,
      },
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return { txId, ...extInfo };
  }

  async swapClmm(params: {
    poolId: string;
    inputMint: string;
    amount: number | string | BN;
    slippage?: number;
  }) {
    const raydium = await this.init();

    // Fetch pool info
    const poolData = await raydium.api.fetchPoolById({ ids: params.poolId });
    const poolInfo = poolData[0];

    // Fetch tick arrays
    const tickArrays = await raydium.clmm.getPoolTickArrays({ poolInfo });

    const inputAmount =
      params.amount instanceof BN
        ? params.amount
        : new BN(params.amount.toString());

    // Calculate output
    const { amountOut } = await raydium.clmm.computeAmountOut({
      poolInfo,
      tickArrays,
      amountIn: inputAmount,
      mintIn: params.inputMint,
      slippage: params.slippage ?? 0.01,
    });

    const { execute } = await raydium.clmm.swap({
      poolInfo,
      inputMint: params.inputMint,
      amountIn: inputAmount,
      amountOutMin: amountOut,
      txVersion: CONFIG.TX_VERSION,
      computeBudgetConfig: {
        units: CONFIG.COMPUTE_UNITS,
        microLamports: CONFIG.PRIORITY_FEE,
      },
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return { txId, amountOut };
  }

  // ==========================================================================
  // LIQUIDITY METHODS
  // ==========================================================================

  async addCpmmLiquidity(params: {
    poolId: string;
    amount: number | string | BN;
    baseIn?: boolean;
    slippage?: number;
  }) {
    const raydium = await this.init();

    const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(params.poolId);

    const inputAmount =
      params.amount instanceof BN
        ? params.amount
        : new BN(params.amount.toString());

    const { execute, extInfo } = await raydium.cpmm.addLiquidity({
      poolInfo,
      inputAmount,
      baseIn: params.baseIn ?? true,
      slippage: params.slippage ?? 0.01,
      txVersion: CONFIG.TX_VERSION,
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return { txId, lpAmount: extInfo.lpAmount };
  }

  async removeCpmmLiquidity(params: {
    poolId: string;
    lpAmount: number | string | BN;
    slippage?: number;
  }) {
    const raydium = await this.init();

    const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(params.poolId);

    const lpAmount =
      params.lpAmount instanceof BN
        ? params.lpAmount
        : new BN(params.lpAmount.toString());

    const { execute, extInfo } = await raydium.cpmm.withdrawLiquidity({
      poolInfo,
      lpAmount,
      slippage: params.slippage ?? 0.01,
      txVersion: CONFIG.TX_VERSION,
    });

    const { txId } = await execute({ sendAndConfirm: true });
    return { txId, amountA: extInfo.amountA, amountB: extInfo.amountB };
  }

  // ==========================================================================
  // POOL INFO
  // ==========================================================================

  async getPoolInfo(poolId: string, type: 'cpmm' | 'clmm' | 'amm' = 'cpmm') {
    const raydium = await this.init();

    switch (type) {
      case 'cpmm':
        return raydium.cpmm.getPoolInfoFromRpc(poolId);
      case 'clmm':
        return raydium.clmm.getPoolInfoFromRpc(poolId);
      case 'amm':
        const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({
          poolId,
        });
        return poolInfo;
    }
  }

  async findPoolsByMints(mint1: string, mint2: string) {
    const raydium = await this.init();
    return raydium.api.fetchPoolByMints({ mint1, mint2 });
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  async getTokenBalance(mint: string): Promise<BN> {
    const raydium = await this.init();
    const account = await raydium.account.getTokenAccount(mint);
    return new BN(account?.amount?.toString() ?? '0');
  }

  async getSolBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.owner.publicKey);
    return balance / 1e9;
  }
}

// =============================================================================
// USAGE EXAMPLE
// =============================================================================

async function main() {
  const client = new RaydiumClient();

  // Initialize
  await client.init();

  // Check balances
  const solBalance = await client.getSolBalance();
  console.log('SOL Balance:', solBalance);

  // Example: Swap 0.1 SOL for USDC on CPMM
  // const result = await client.swapCpmm({
  //   poolId: '7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny',
  //   inputMint: 'So11111111111111111111111111111111111111112',
  //   amount: 100000000, // 0.1 SOL in lamports
  //   slippage: 0.01,
  // });
  // console.log('Swap TX:', result.txId);
}

// Run if executed directly
// main().catch(console.error);

export default RaydiumClient;
