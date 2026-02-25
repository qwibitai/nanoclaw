/**
 * Kamino Liquidity SDK Setup Template
 *
 * This template provides a ready-to-use setup for Kamino Liquidity operations.
 * Copy this file and customize for your project.
 */

import { Kamino } from "@kamino-finance/kliquidity-sdk";
import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  Commitment,
} from "@solana/web3.js";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC endpoint
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Cluster
  cluster: "mainnet-beta" as const,

  // Transaction settings
  commitment: "confirmed" as Commitment,
  defaultSlippageBps: 50, // 0.5%
  computeBudget: 400000,

  // Wallet path
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// WALLET LOADING
// ============================================================================

function loadWallet(): Keypair {
  const walletPath = path.resolve(CONFIG.walletPath);

  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Buffer.from(secretKey));
}

// ============================================================================
// KAMINO LIQUIDITY CLIENT CLASS
// ============================================================================

export class KaminoLiquidityClient {
  private connection: Connection;
  private kamino: Kamino;
  private wallet: Keypair;

  constructor(wallet?: Keypair) {
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);
    this.kamino = new Kamino(CONFIG.cluster, this.connection);
    this.wallet = wallet || loadWallet();
  }

  // Get wallet address
  get address(): PublicKey {
    return this.wallet.publicKey;
  }

  // ========================================================================
  // STRATEGY DISCOVERY
  // ========================================================================

  async getAllStrategies() {
    return this.kamino.getStrategiesWithAddresses();
  }

  async getFilteredStrategies(filters: {
    strategyType?: "NON_PEGGED" | "PEGGED" | "STABLE";
    status?: "LIVE" | "STAGING" | "DEPRECATED";
    tokenA?: PublicKey;
    tokenB?: PublicKey;
    dex?: "ORCA" | "RAYDIUM" | "METEORA";
  }) {
    return this.kamino.getAllStrategiesWithFilters(filters);
  }

  async getStrategy(address: PublicKey) {
    return this.kamino.getStrategyByAddress(address);
  }

  async getStrategyByKToken(kTokenMint: PublicKey) {
    return this.kamino.getStrategyByKTokenMint(kTokenMint);
  }

  // ========================================================================
  // STRATEGY DATA
  // ========================================================================

  async getStrategyInfo(address: PublicKey) {
    const strategy = await this.kamino.getStrategyByAddress(address);
    if (!strategy) throw new Error("Strategy not found");

    const shareData = await this.kamino.getStrategyShareData(address);
    const range = await this.kamino.getStrategyRange(address);

    return {
      address: address.toString(),
      tokenAMint: strategy.tokenAMint.toString(),
      tokenBMint: strategy.tokenBMint.toString(),
      sharesMint: strategy.sharesMint.toString(),
      sharePrice: shareData.sharePrice,
      totalShares: shareData.totalShares,
      tvl: shareData.totalShares.mul(shareData.sharePrice),
      tokenAPerShare: shareData.tokenAPerShare,
      tokenBPerShare: shareData.tokenBPerShare,
      currentPrice: range.currentPrice,
      lowerPrice: range.lowerPrice,
      upperPrice: range.upperPrice,
      isInRange: range.isInRange,
    };
  }

  async getSharePrice(address: PublicKey): Promise<Decimal> {
    return this.kamino.getStrategySharePrice(address);
  }

  async getPositionRange(address: PublicKey) {
    return this.kamino.getStrategyRange(address);
  }

  // ========================================================================
  // USER POSITIONS
  // ========================================================================

  async getUserPositions() {
    const strategies = await this.kamino.getStrategiesWithAddresses();
    const positions = [];

    for (const { address, strategy } of strategies) {
      const kTokenAta = await this.kamino.getAssociatedTokenAddressAndData(
        strategy.sharesMint,
        this.wallet.publicKey
      );

      if (!kTokenAta.exists) continue;

      const balance = await this.kamino.getTokenAccountBalanceOrZero(kTokenAta.address);
      if (balance.lte(0)) continue;

      const shareData = await this.kamino.getStrategyShareData(address);
      const value = balance.mul(shareData.sharePrice);

      positions.push({
        strategyAddress: address.toString(),
        shares: balance,
        sharePrice: shareData.sharePrice,
        value,
        tokenA: balance.mul(shareData.tokenAPerShare),
        tokenB: balance.mul(shareData.tokenBPerShare),
      });
    }

    return positions;
  }

  async getShareBalance(strategyAddress: PublicKey): Promise<Decimal> {
    const strategy = await this.kamino.getStrategyByAddress(strategyAddress);
    if (!strategy) return new Decimal(0);

    const kTokenAta = await this.kamino.getAssociatedTokenAddressAndData(
      strategy.sharesMint,
      this.wallet.publicKey
    );

    if (!kTokenAta.exists) return new Decimal(0);

    return this.kamino.getTokenAccountBalanceOrZero(kTokenAta.address);
  }

  // ========================================================================
  // DEPOSIT OPERATIONS
  // ========================================================================

  async deposit(
    strategyAddress: PublicKey,
    tokenAAmount: Decimal,
    tokenBAmount: Decimal,
    slippageBps?: number
  ): Promise<string> {
    const slippage = new Decimal(slippageBps || CONFIG.defaultSlippageBps).div(10000);

    console.log(`Depositing to strategy ${strategyAddress.toString()}...`);
    console.log(`  Token A: ${tokenAAmount.toString()}`);
    console.log(`  Token B: ${tokenBAmount.toString()}`);
    console.log(`  Slippage: ${slippage.mul(100).toString()}%`);

    const depositIxs = await this.kamino.deposit(
      strategyAddress,
      this.wallet.publicKey,
      tokenAAmount,
      tokenBAmount,
      slippage
    );

    const tx = this.kamino.createTransactionWithExtraBudget(CONFIG.computeBudget);
    tx.add(...depositIxs);
    await this.kamino.assignBlockInfoToTransaction(tx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Deposit successful:", signature);
    return signature;
  }

  async singleTokenDeposit(
    strategyAddress: PublicKey,
    tokenAmount: Decimal,
    isTokenA: boolean,
    slippageBps?: number
  ): Promise<string> {
    const slippage = new Decimal(slippageBps || 100).div(10000); // 1% default for single-sided

    console.log(`Single token deposit to ${strategyAddress.toString()}...`);
    console.log(`  Amount: ${tokenAmount.toString()}`);
    console.log(`  Token: ${isTokenA ? "A" : "B"}`);

    const depositIxs = await this.kamino.singleTokenDeposit(
      strategyAddress,
      this.wallet.publicKey,
      tokenAmount,
      isTokenA,
      slippage
    );

    const tx = this.kamino.createTransactionWithExtraBudget(600000);
    tx.add(...depositIxs);
    await this.kamino.assignBlockInfoToTransaction(tx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Single token deposit successful:", signature);
    return signature;
  }

  // ========================================================================
  // WITHDRAWAL OPERATIONS
  // ========================================================================

  async withdraw(
    strategyAddress: PublicKey,
    sharesToWithdraw: Decimal,
    slippageBps?: number
  ): Promise<string> {
    const slippage = new Decimal(slippageBps || CONFIG.defaultSlippageBps).div(10000);

    console.log(`Withdrawing from ${strategyAddress.toString()}...`);
    console.log(`  Shares: ${sharesToWithdraw.toString()}`);

    const withdrawIxs = await this.kamino.withdraw(
      strategyAddress,
      this.wallet.publicKey,
      sharesToWithdraw,
      slippage
    );

    const tx = this.kamino.createTransactionWithExtraBudget(CONFIG.computeBudget);
    tx.add(...withdrawIxs);
    await this.kamino.assignBlockInfoToTransaction(tx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Withdrawal successful:", signature);
    return signature;
  }

  async withdrawAll(
    strategyAddress: PublicKey,
    slippageBps?: number
  ): Promise<string> {
    const slippage = new Decimal(slippageBps || CONFIG.defaultSlippageBps).div(10000);

    console.log(`Withdrawing all from ${strategyAddress.toString()}...`);

    const withdrawIxs = await this.kamino.withdrawAllShares(
      strategyAddress,
      this.wallet.publicKey,
      slippage
    );

    const tx = this.kamino.createTransactionWithExtraBudget(CONFIG.computeBudget);
    tx.add(...withdrawIxs);
    await this.kamino.assignBlockInfoToTransaction(tx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Full withdrawal successful:", signature);
    return signature;
  }

  // ========================================================================
  // FEE COLLECTION
  // ========================================================================

  async collectFees(strategyAddress: PublicKey): Promise<string> {
    console.log(`Collecting fees from ${strategyAddress.toString()}...`);

    const collectIxs = await this.kamino.collectFeesAndRewards(
      strategyAddress,
      this.wallet.publicKey
    );

    const tx = this.kamino.createTransactionWithExtraBudget(300000);
    tx.add(...collectIxs);
    await this.kamino.assignBlockInfoToTransaction(tx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Fees collected:", signature);
    return signature;
  }

  // ========================================================================
  // UTILITY METHODS
  // ========================================================================

  async getSupportedDexes() {
    return this.kamino.getSupportedDexes();
  }

  async getRebalanceMethods() {
    return this.kamino.getRebalanceMethods();
  }

  async getPoolsForPair(
    dex: "ORCA" | "RAYDIUM" | "METEORA",
    tokenA: PublicKey,
    tokenB: PublicKey
  ) {
    switch (dex) {
      case "ORCA":
        return this.kamino.getOrcaPoolsForTokens(tokenA, tokenB);
      case "RAYDIUM":
        return this.kamino.getRaydiumPoolsForTokens(tokenA, tokenB);
      case "METEORA":
        return this.kamino.getMeteoraPoolsForTokens(tokenA, tokenB);
    }
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  const client = new KaminoLiquidityClient();

  // Get live strategies
  const strategies = await client.getFilteredStrategies({
    status: "LIVE",
    strategyType: "NON_PEGGED",
  });

  console.log(`Found ${strategies.length} live non-pegged strategies`);

  // Get first strategy info
  if (strategies.length > 0) {
    const info = await client.getStrategyInfo(strategies[0].address);
    console.log("\nFirst Strategy Info:", info);
  }

  // Get user positions
  const positions = await client.getUserPositions();
  console.log("\nYour Positions:", positions);

  // Example operations (uncomment to use):
  // const strategyAddress = new PublicKey("...");
  // await client.deposit(strategyAddress, new Decimal(0.1), new Decimal(10));
  // await client.withdraw(strategyAddress, new Decimal(0.05));
  // await client.withdrawAll(strategyAddress);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
