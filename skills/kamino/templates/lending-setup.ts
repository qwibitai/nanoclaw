/**
 * Kamino Lending SDK Setup Template
 *
 * This template provides a ready-to-use setup for Kamino Lend operations.
 * Copy this file and customize for your project.
 */

import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
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
  // RPC endpoint (use your own for production)
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Main lending market address
  mainMarket: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),

  // Transaction settings
  commitment: "confirmed" as Commitment,
  extraComputeBudget: 300000,

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
// KAMINO CLIENT CLASS
// ============================================================================

export class KaminoLendClient {
  private connection: Connection;
  private wallet: Keypair;
  private market: KaminoMarket | null = null;

  constructor(wallet?: Keypair) {
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);
    this.wallet = wallet || loadWallet();
  }

  // Initialize/load market
  async initialize(): Promise<void> {
    console.log("Initializing Kamino Lend client...");
    this.market = await KaminoMarket.load(
      this.connection,
      CONFIG.mainMarket,
      CONFIG.commitment
    );
    await this.market.loadReserves();
    console.log(`Market loaded with ${this.market.reserves.size} reserves`);
  }

  // Ensure market is loaded
  private ensureMarket(): KaminoMarket {
    if (!this.market) {
      throw new Error("Market not initialized. Call initialize() first.");
    }
    return this.market;
  }

  // Get wallet address
  get address(): PublicKey {
    return this.wallet.publicKey;
  }

  // ========================================================================
  // RESERVE METHODS
  // ========================================================================

  async getReserveInfo(symbol: string) {
    const market = this.ensureMarket();
    const reserve = market.getReserve(symbol);

    if (!reserve) {
      throw new Error(`Reserve ${symbol} not found`);
    }

    return {
      symbol: reserve.stats.symbol,
      mint: reserve.stats.mint,
      decimals: reserve.stats.decimals,
      price: reserve.stats.price,
      totalDeposits: reserve.stats.totalDepositsWads,
      totalBorrows: reserve.stats.totalBorrowsWads,
      availableLiquidity: reserve.stats.availableLiquidityWads,
      supplyApy: reserve.stats.supplyInterestAPY,
      borrowApy: reserve.stats.borrowInterestAPY,
      utilizationRate: reserve.stats.utilizationRate,
      ltv: reserve.stats.loanToValueRatio,
      liquidationThreshold: reserve.stats.liquidationThreshold,
    };
  }

  async getAllReserves() {
    const market = this.ensureMarket();
    const reserves = [];

    for (const [, reserve] of market.reserves) {
      reserves.push({
        symbol: reserve.stats.symbol,
        supplyApy: reserve.stats.supplyInterestAPY,
        borrowApy: reserve.stats.borrowInterestAPY,
        ltv: reserve.stats.loanToValueRatio,
      });
    }

    return reserves;
  }

  // ========================================================================
  // OBLIGATION METHODS
  // ========================================================================

  async getObligation() {
    const market = this.ensureMarket();
    await market.refreshAll();
    return market.getUserVanillaObligation(this.wallet.publicKey);
  }

  async getPositionSummary() {
    const obligation = await this.getObligation();

    if (!obligation) {
      return {
        hasPosition: false,
        deposits: [],
        borrows: [],
        totalDeposited: new Decimal(0),
        totalBorrowed: new Decimal(0),
        netValue: new Decimal(0),
        healthFactor: Infinity,
        availableToBorrow: new Decimal(0),
      };
    }

    const market = this.ensureMarket();
    const stats = obligation.refreshedStats;

    const deposits = obligation.deposits.map((d) => {
      const reserve = market.reserves.get(d.depositReserve.toString());
      return {
        symbol: reserve?.stats.symbol || "Unknown",
        valueUsd: d.marketValue,
      };
    });

    const borrows = obligation.borrows.map((b) => {
      const reserve = market.reserves.get(b.borrowReserve.toString());
      return {
        symbol: reserve?.stats.symbol || "Unknown",
        valueUsd: b.marketValue,
      };
    });

    const healthFactor = stats.borrowedValue.gt(0)
      ? stats.borrowLimit.div(stats.borrowedValue).toNumber()
      : Infinity;

    return {
      hasPosition: true,
      deposits,
      borrows,
      totalDeposited: stats.depositedValue,
      totalBorrowed: stats.borrowedValue,
      netValue: stats.netAccountValue,
      borrowLimit: stats.borrowLimit,
      healthFactor,
      availableToBorrow: stats.borrowLimit.sub(stats.borrowedValue),
    };
  }

  // ========================================================================
  // DEPOSIT METHODS
  // ========================================================================

  async deposit(symbol: string, amountInTokens: number): Promise<string> {
    const market = this.ensureMarket();
    const reserve = market.getReserve(symbol);

    if (!reserve) {
      throw new Error(`Reserve ${symbol} not found`);
    }

    const amountBase = new Decimal(amountInTokens)
      .mul(new Decimal(10).pow(reserve.stats.decimals))
      .floor()
      .toString();

    console.log(`Depositing ${amountInTokens} ${symbol}...`);

    const action = await KaminoAction.buildDepositTxns(
      market,
      amountBase,
      symbol,
      this.wallet.publicKey,
      new VanillaObligation(PROGRAM_ID),
      CONFIG.extraComputeBudget,
      true,
      undefined,
      undefined,
      CONFIG.commitment
    );

    return this.sendAction(action);
  }

  // ========================================================================
  // WITHDRAW METHODS
  // ========================================================================

  async withdraw(symbol: string, amountInTokens: number | "max"): Promise<string> {
    const market = this.ensureMarket();
    const reserve = market.getReserve(symbol);

    if (!reserve) {
      throw new Error(`Reserve ${symbol} not found`);
    }

    const withdrawAmount =
      amountInTokens === "max"
        ? "max"
        : new Decimal(amountInTokens)
            .mul(new Decimal(10).pow(reserve.stats.decimals))
            .floor()
            .toString();

    console.log(`Withdrawing ${amountInTokens} ${symbol}...`);

    const action = await KaminoAction.buildWithdrawTxns(
      market,
      withdrawAmount,
      symbol,
      this.wallet.publicKey,
      new VanillaObligation(PROGRAM_ID),
      CONFIG.extraComputeBudget,
      true,
      undefined,
      CONFIG.commitment
    );

    return this.sendAction(action);
  }

  // ========================================================================
  // BORROW METHODS
  // ========================================================================

  async borrow(symbol: string, amountInTokens: number): Promise<string> {
    const market = this.ensureMarket();
    const reserve = market.getReserve(symbol);

    if (!reserve) {
      throw new Error(`Reserve ${symbol} not found`);
    }

    const amountBase = new Decimal(amountInTokens)
      .mul(new Decimal(10).pow(reserve.stats.decimals))
      .floor()
      .toString();

    console.log(`Borrowing ${amountInTokens} ${symbol}...`);

    const action = await KaminoAction.buildBorrowTxns(
      market,
      amountBase,
      symbol,
      this.wallet.publicKey,
      new VanillaObligation(PROGRAM_ID),
      CONFIG.extraComputeBudget,
      true,
      false,
      undefined,
      undefined,
      CONFIG.commitment
    );

    return this.sendAction(action);
  }

  // ========================================================================
  // REPAY METHODS
  // ========================================================================

  async repay(symbol: string, amountInTokens: number | "max"): Promise<string> {
    const market = this.ensureMarket();
    const reserve = market.getReserve(symbol);

    if (!reserve) {
      throw new Error(`Reserve ${symbol} not found`);
    }

    const repayAmount =
      amountInTokens === "max"
        ? "max"
        : new Decimal(amountInTokens)
            .mul(new Decimal(10).pow(reserve.stats.decimals))
            .floor()
            .toString();

    console.log(`Repaying ${amountInTokens} ${symbol}...`);

    const action = await KaminoAction.buildRepayTxns(
      market,
      repayAmount,
      symbol,
      this.wallet.publicKey,
      new VanillaObligation(PROGRAM_ID),
      CONFIG.extraComputeBudget,
      true,
      undefined,
      CONFIG.commitment
    );

    return this.sendAction(action);
  }

  // ========================================================================
  // HELPER METHODS
  // ========================================================================

  private async sendAction(action: KaminoAction): Promise<string> {
    const instructions = [
      ...action.setupIxs,
      ...action.lendingIxs,
      ...action.cleanupIxs,
    ];

    const tx = new Transaction().add(...instructions);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.wallet],
      { commitment: CONFIG.commitment }
    );

    console.log("Transaction successful:", signature);
    return signature;
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  const client = new KaminoLendClient();
  await client.initialize();

  // Get reserve info
  const solReserve = await client.getReserveInfo("SOL");
  console.log("\nSOL Reserve:", solReserve);

  // Get position summary
  const position = await client.getPositionSummary();
  console.log("\nPosition:", position);

  // Example operations (uncomment to use):
  // await client.deposit("SOL", 0.1);
  // await client.borrow("USDC", 10);
  // await client.repay("USDC", 5);
  // await client.withdraw("SOL", 0.05);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
