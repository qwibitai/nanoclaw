/**
 * Orca Whirlpools: Setup Template
 *
 * This template provides a ready-to-use setup for building applications
 * with the Orca Whirlpools SDK. Copy this file to your project and customize.
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Install dependencies: npm install @orca-so/whirlpools @solana/kit
 * 3. Update the CONFIG values
 * 4. Run with: npx ts-node setup.ts
 */

import {
  // Configuration
  setWhirlpoolsConfig,
  setRpc,
  setPayerFromBytes,
  setPriorityFeeSetting,
  setJitoTipSetting,
  setDefaultSlippageToleranceBps,
  setDefaultFunder,
  resetConfiguration,
  getPayer,
  // Swaps
  swap,
  swapInstructions,
  // Position management
  openPosition,
  openPositionInstructions,
  openFullRangePosition,
  openFullRangePositionInstructions,
  increaseLiquidity,
  increaseLiquidityInstructions,
  decreaseLiquidity,
  decreaseLiquidityInstructions,
  harvestPosition,
  harvestPositionInstructions,
  closePosition,
  closePositionInstructions,
  // Pool operations
  createSplashPool,
  createSplashPoolInstructions,
  createConcentratedLiquidityPool,
  createConcentratedLiquidityPoolInstructions,
  // Fetching data
  fetchPositionsForOwner,
  fetchPositionsInWhirlpool,
  fetchWhirlpoolsByTokenPair,
  fetchSplashPool,
  fetchConcentratedLiquidityPool,
  // Utilities
  orderMints,
} from "@orca-so/whirlpools";
import { createSolanaRpc, address, Address, KeyPairSigner } from "@solana/kit";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// CONFIGURATION - Customize these values for your project
// ============================================================================

const CONFIG = {
  // Network configuration
  network: "solanaMainnet" as
    | "solanaMainnet"
    | "solanaDevnet"
    | "eclipseMainnet"
    | "eclipseTestnet",

  // RPC endpoint (use environment variable in production)
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Path to wallet keypair file
  walletPath: process.env.WALLET_PATH || "./keypair.json",

  // Default slippage tolerance in basis points (100 = 1%)
  defaultSlippage: 100,

  // Priority fee configuration
  priorityFee: {
    type: "dynamic" as const,
    percentile: 75,
  },

  // Jito tip configuration (set to null to disable)
  jitoTip: null as { type: "dynamic"; percentile: number } | null,

  // Common token addresses (Solana Mainnet)
  tokens: {
    SOL: address("So11111111111111111111111111111111111111112"),
    USDC: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    USDT: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    ORCA: address("orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"),
    BONK: address("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    JUP: address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),
  },

  // Popular pool addresses
  pools: {
    SOL_USDC: address("7qbRF6YsyGuLUVs6Y1sfC93Vulo2YBcmfkPHJmxRQWYL"),
    SOL_USDT: address("4GkRbcYg1VKsZropgai4dMf2Nj2PkXNLf43knFpavrSi"),
    USDC_USDT: address("4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4"),
  },
};

// ============================================================================
// TYPES
// ============================================================================

export interface OrcaClientConfig {
  network?: typeof CONFIG.network;
  rpcUrl?: string;
  walletPath?: string;
  defaultSlippage?: number;
}

export interface SwapResult {
  signature: string;
  inputAmount: bigint;
  outputAmount: bigint;
}

export interface PositionResult {
  signature: string;
  positionMint: Address;
  tokenADeposited: bigint;
  tokenBDeposited: bigint;
}

// ============================================================================
// ORCA CLIENT CLASS
// ============================================================================

export class OrcaClient {
  private rpc: ReturnType<typeof createSolanaRpc>;
  private wallet: KeyPairSigner | null = null;
  private initialized = false;

  constructor(private config: OrcaClientConfig = {}) {
    this.rpc = createSolanaRpc(config.rpcUrl || CONFIG.rpcUrl);
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize the client with wallet and configuration
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Set network configuration
    await setWhirlpoolsConfig(this.config.network || CONFIG.network);

    // Set RPC
    await setRpc(this.config.rpcUrl || CONFIG.rpcUrl);

    // Load wallet
    const walletPath = this.config.walletPath || CONFIG.walletPath;
    if (fs.existsSync(walletPath)) {
      const keyPairBytes = new Uint8Array(
        JSON.parse(fs.readFileSync(walletPath, "utf8"))
      );
      this.wallet = await setPayerFromBytes(keyPairBytes);
      await setDefaultFunder(this.wallet);
    }

    // Set default slippage
    await setDefaultSlippageToleranceBps(
      this.config.defaultSlippage || CONFIG.defaultSlippage
    );

    // Set priority fees
    if (CONFIG.priorityFee) {
      await setPriorityFeeSetting(CONFIG.priorityFee);
    }

    // Set Jito tips (optional)
    if (CONFIG.jitoTip) {
      await setJitoTipSetting(CONFIG.jitoTip);
    }

    this.initialized = true;
    console.log("Orca client initialized");
    if (this.wallet) {
      console.log("Wallet:", this.wallet.address);
    }
  }

  /**
   * Reset all configuration
   */
  async reset(): Promise<void> {
    await resetConfiguration();
    this.initialized = false;
    this.wallet = null;
  }

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  get walletAddress(): Address | undefined {
    return this.wallet?.address;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  // --------------------------------------------------------------------------
  // Swap Operations
  // --------------------------------------------------------------------------

  /**
   * Execute a token swap
   */
  async swap(
    poolAddress: Address,
    inputMint: Address,
    inputAmount: bigint,
    slippageBps?: number
  ): Promise<string> {
    await this.ensureInitialized();

    return await swap(
      this.rpc,
      { inputAmount, mint: inputMint },
      poolAddress,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );
  }

  /**
   * Get swap quote without executing
   */
  async getSwapQuote(
    poolAddress: Address,
    inputMint: Address,
    inputAmount: bigint,
    slippageBps?: number
  ) {
    await this.ensureInitialized();

    const { quote } = await swapInstructions(
      this.rpc,
      { inputAmount, mint: inputMint },
      poolAddress,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );

    return quote;
  }

  // --------------------------------------------------------------------------
  // Position Operations
  // --------------------------------------------------------------------------

  /**
   * Open a concentrated liquidity position
   */
  async openConcentratedPosition(
    poolAddress: Address,
    tokenAmount: { tokenA?: bigint; tokenB?: bigint; liquidity?: bigint },
    lowerPrice: number,
    upperPrice: number,
    slippageBps?: number
  ) {
    await this.ensureInitialized();

    const param = tokenAmount.tokenA
      ? { tokenA: tokenAmount.tokenA }
      : tokenAmount.tokenB
      ? { tokenB: tokenAmount.tokenB }
      : { liquidity: tokenAmount.liquidity! };

    const { quote, positionMint, callback } = await openPositionInstructions(
      this.rpc,
      poolAddress,
      param,
      lowerPrice,
      upperPrice,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );

    const signature = await callback();

    return {
      signature,
      positionMint,
      quote,
    };
  }

  /**
   * Open a full-range position
   */
  async openFullRangePosition(
    poolAddress: Address,
    tokenAmount: { tokenA?: bigint; tokenB?: bigint },
    slippageBps?: number
  ) {
    await this.ensureInitialized();

    const param = tokenAmount.tokenA
      ? { tokenA: tokenAmount.tokenA }
      : { tokenB: tokenAmount.tokenB! };

    const { quote, positionMint, callback } =
      await openFullRangePositionInstructions(
        this.rpc,
        poolAddress,
        param,
        slippageBps || CONFIG.defaultSlippage,
        this.wallet!
      );

    const signature = await callback();

    return {
      signature,
      positionMint,
      quote,
    };
  }

  /**
   * Increase liquidity in a position
   */
  async increaseLiquidity(
    positionMint: Address,
    tokenAmount: { tokenA?: bigint; tokenB?: bigint; liquidity?: bigint },
    slippageBps?: number
  ) {
    await this.ensureInitialized();

    const param = tokenAmount.tokenA
      ? { tokenA: tokenAmount.tokenA }
      : tokenAmount.tokenB
      ? { tokenB: tokenAmount.tokenB }
      : { liquidity: tokenAmount.liquidity! };

    const { quote, callback } = await increaseLiquidityInstructions(
      this.rpc,
      positionMint,
      param,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );

    const signature = await callback();

    return { signature, quote };
  }

  /**
   * Decrease liquidity in a position
   */
  async decreaseLiquidity(
    positionMint: Address,
    amount: { tokenA?: bigint; tokenB?: bigint; liquidity?: bigint },
    slippageBps?: number
  ) {
    await this.ensureInitialized();

    const param = amount.tokenA
      ? { tokenA: amount.tokenA }
      : amount.tokenB
      ? { tokenB: amount.tokenB }
      : { liquidity: amount.liquidity! };

    const { quote, callback } = await decreaseLiquidityInstructions(
      this.rpc,
      positionMint,
      param,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );

    const signature = await callback();

    return { signature, quote };
  }

  /**
   * Harvest fees and rewards from a position
   */
  async harvestFees(positionMint: Address) {
    await this.ensureInitialized();

    const { feesQuote, rewardsQuote, callback } =
      await harvestPositionInstructions(this.rpc, positionMint, this.wallet!);

    const signature = await callback();

    return { signature, feesQuote, rewardsQuote };
  }

  /**
   * Close a position and withdraw all liquidity
   */
  async closePosition(positionMint: Address, slippageBps?: number) {
    await this.ensureInitialized();

    const { quote, feesQuote, callback } = await closePositionInstructions(
      this.rpc,
      positionMint,
      slippageBps || CONFIG.defaultSlippage,
      this.wallet!
    );

    const signature = await callback();

    return { signature, quote, feesQuote };
  }

  // --------------------------------------------------------------------------
  // Fetch Operations
  // --------------------------------------------------------------------------

  /**
   * Get all positions for the wallet
   */
  async getMyPositions() {
    await this.ensureInitialized();
    return await fetchPositionsForOwner(this.rpc, this.wallet!.address);
  }

  /**
   * Get positions in a specific pool
   */
  async getPoolPositions(poolAddress: Address) {
    await this.ensureInitialized();
    return await fetchPositionsInWhirlpool(this.rpc, poolAddress);
  }

  /**
   * Get pool data
   */
  async getPool(poolAddress: Address) {
    await this.ensureInitialized();
    return await fetchConcentratedLiquidityPool(this.rpc, poolAddress);
  }

  /**
   * Find pools for a token pair
   */
  async findPools(tokenMintA: Address, tokenMintB: Address) {
    await this.ensureInitialized();
    const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);
    return await fetchWhirlpoolsByTokenPair(this.rpc, orderedA, orderedB);
  }

  // --------------------------------------------------------------------------
  // Pool Creation
  // --------------------------------------------------------------------------

  /**
   * Create a new concentrated liquidity pool
   */
  async createPool(
    tokenMintA: Address,
    tokenMintB: Address,
    tickSpacing: 1 | 8 | 64 | 128,
    initialPrice: number
  ) {
    await this.ensureInitialized();

    const [orderedA, orderedB] = orderMints(tokenMintA, tokenMintB);

    const { poolAddress, initializationCost, callback } =
      await createConcentratedLiquidityPoolInstructions(
        this.rpc,
        orderedA,
        orderedB,
        tickSpacing,
        initialPrice,
        this.wallet!
      );

    const signature = await callback();

    return { signature, poolAddress, initializationCost };
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    if (!this.wallet) {
      throw new Error("Wallet not loaded. Provide a valid wallet path.");
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format token amount for display
 */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0").slice(0, 4)}`;
}

/**
 * Parse token amount from string
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=== Orca Client Setup ===\n");

  // Initialize client
  const client = new OrcaClient({
    network: "solanaMainnet",
    rpcUrl: CONFIG.rpcUrl,
    walletPath: CONFIG.walletPath,
  });

  await client.initialize();

  // Example: Get positions
  console.log("\nFetching positions...");
  const positions = await client.getMyPositions();
  console.log("Found", positions.length, "positions");

  // Example: Get pool data
  console.log("\nFetching SOL/USDC pool...");
  const pool = await client.getPool(CONFIG.pools.SOL_USDC);
  console.log("Pool liquidity:", pool.liquidity.toString());

  // Example: Get swap quote
  console.log("\nGetting swap quote (1 SOL -> USDC)...");
  const quote = await client.getSwapQuote(
    CONFIG.pools.SOL_USDC,
    CONFIG.tokens.SOL,
    1_000_000_000n // 1 SOL
  );
  console.log("Expected output:", formatTokenAmount(quote.tokenEstOut, 6), "USDC");

  console.log("\n=== Setup Complete ===");
  console.log("Customize this template for your specific use case.");
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
