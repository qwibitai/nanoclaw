/**
 * Kamino Full Integration Template
 *
 * Complete example integrating all Kamino SDKs:
 * - klend-sdk (Lending)
 * - kliquidity-sdk (Liquidity)
 * - scope-sdk (Oracle)
 */

import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import { Kamino } from "@kamino-finance/kliquidity-sdk";
import { Scope } from "@kamino-finance/scope-sdk";
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

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  cluster: "mainnet-beta" as const,
  commitment: "confirmed" as Commitment,
  mainMarket: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// KAMINO FULL CLIENT
// ============================================================================

export class KaminoClient {
  private connection: Connection;
  private wallet: Keypair;

  // SDK instances
  private lendingMarket: KaminoMarket | null = null;
  private liquidity: Kamino;
  private oracle: Scope;

  constructor(walletPath?: string) {
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);
    this.wallet = this.loadWallet(walletPath || CONFIG.walletPath);
    this.liquidity = new Kamino(CONFIG.cluster, this.connection);
    this.oracle = new Scope(CONFIG.cluster, this.connection);
  }

  private loadWallet(path: string): Keypair {
    const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
    return Keypair.fromSecretKey(Buffer.from(secretKey));
  }

  get address(): PublicKey {
    return this.wallet.publicKey;
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  async initialize(): Promise<void> {
    console.log("Initializing Kamino Client...");
    console.log("Wallet:", this.address.toString());

    // Initialize lending market
    this.lendingMarket = await KaminoMarket.load(
      this.connection,
      CONFIG.mainMarket,
      CONFIG.commitment
    );
    await this.lendingMarket.loadReserves();

    console.log(`Lending market loaded with ${this.lendingMarket.reserves.size} reserves`);
    console.log("Liquidity and Oracle SDKs ready");
  }

  private ensureLending(): KaminoMarket {
    if (!this.lendingMarket) {
      throw new Error("Lending market not initialized. Call initialize() first.");
    }
    return this.lendingMarket;
  }

  // ========================================================================
  // ORACLE METHODS
  // ========================================================================

  async getPrice(token: string): Promise<Decimal> {
    const priceData = await this.oracle.getPrice(token);
    return priceData.price;
  }

  async getAllPrices(): Promise<Map<string, Decimal>> {
    const prices = await this.oracle.getOraclePrices();
    const result = new Map<string, Decimal>();
    for (const [token, data] of prices.entries()) {
      result.set(token, data.price);
    }
    return result;
  }

  async getValidatedPrice(
    token: string,
    maxStaleSlots: number = 100,
    maxConfidenceRatio: number = 0.02
  ): Promise<Decimal | null> {
    const priceWithMeta = await this.oracle.getPriceWithMetadata(token);

    if (priceWithMeta.status !== "TRADING") return null;
    if (priceWithMeta.ageSlots > maxStaleSlots) return null;

    const confidenceRatio = priceWithMeta.confidence.div(priceWithMeta.price);
    if (confidenceRatio.gt(maxConfidenceRatio)) return null;

    return priceWithMeta.price;
  }

  // ========================================================================
  // LENDING METHODS
  // ========================================================================

  async getLendingReserves() {
    const market = this.ensureLending();
    const reserves = [];

    for (const [, reserve] of market.reserves) {
      reserves.push({
        symbol: reserve.stats.symbol,
        supplyApy: reserve.stats.supplyInterestAPY,
        borrowApy: reserve.stats.borrowInterestAPY,
        ltv: reserve.stats.loanToValueRatio,
        price: reserve.stats.price,
      });
    }

    return reserves;
  }

  async getLendingPosition() {
    const market = this.ensureLending();
    await market.refreshAll();

    const obligation = await market.getUserVanillaObligation(this.address);
    if (!obligation) {
      return {
        hasPosition: false,
        deposits: [],
        borrows: [],
        totalDeposited: new Decimal(0),
        totalBorrowed: new Decimal(0),
        healthFactor: Infinity,
      };
    }

    const stats = obligation.refreshedStats;

    return {
      hasPosition: true,
      deposits: obligation.deposits.map((d) => ({
        reserve: market.reserves.get(d.depositReserve.toString())?.stats.symbol,
        value: d.marketValue,
      })),
      borrows: obligation.borrows.map((b) => ({
        reserve: market.reserves.get(b.borrowReserve.toString())?.stats.symbol,
        value: b.marketValue,
      })),
      totalDeposited: stats.depositedValue,
      totalBorrowed: stats.borrowedValue,
      healthFactor: stats.borrowedValue.gt(0)
        ? stats.borrowLimit.div(stats.borrowedValue).toNumber()
        : Infinity,
    };
  }

  async deposit(symbol: string, amount: number): Promise<string> {
    const market = this.ensureLending();
    const reserve = market.getReserve(symbol);
    if (!reserve) throw new Error(`Reserve ${symbol} not found`);

    const amountBase = new Decimal(amount)
      .mul(new Decimal(10).pow(reserve.stats.decimals))
      .floor()
      .toString();

    const action = await KaminoAction.buildDepositTxns(
      market,
      amountBase,
      symbol,
      this.address,
      new VanillaObligation(PROGRAM_ID),
      300000,
      true
    );

    return this.sendLendingAction(action);
  }

  async withdraw(symbol: string, amount: number | "max"): Promise<string> {
    const market = this.ensureLending();
    const reserve = market.getReserve(symbol);
    if (!reserve) throw new Error(`Reserve ${symbol} not found`);

    const withdrawAmount =
      amount === "max"
        ? "max"
        : new Decimal(amount)
            .mul(new Decimal(10).pow(reserve.stats.decimals))
            .floor()
            .toString();

    const action = await KaminoAction.buildWithdrawTxns(
      market,
      withdrawAmount,
      symbol,
      this.address,
      new VanillaObligation(PROGRAM_ID),
      300000,
      true
    );

    return this.sendLendingAction(action);
  }

  async borrow(symbol: string, amount: number): Promise<string> {
    const market = this.ensureLending();
    const reserve = market.getReserve(symbol);
    if (!reserve) throw new Error(`Reserve ${symbol} not found`);

    const amountBase = new Decimal(amount)
      .mul(new Decimal(10).pow(reserve.stats.decimals))
      .floor()
      .toString();

    const action = await KaminoAction.buildBorrowTxns(
      market,
      amountBase,
      symbol,
      this.address,
      new VanillaObligation(PROGRAM_ID),
      300000,
      true,
      false
    );

    return this.sendLendingAction(action);
  }

  async repay(symbol: string, amount: number | "max"): Promise<string> {
    const market = this.ensureLending();
    const reserve = market.getReserve(symbol);
    if (!reserve) throw new Error(`Reserve ${symbol} not found`);

    const repayAmount =
      amount === "max"
        ? "max"
        : new Decimal(amount)
            .mul(new Decimal(10).pow(reserve.stats.decimals))
            .floor()
            .toString();

    const action = await KaminoAction.buildRepayTxns(
      market,
      repayAmount,
      symbol,
      this.address,
      new VanillaObligation(PROGRAM_ID),
      300000,
      true
    );

    return this.sendLendingAction(action);
  }

  private async sendLendingAction(action: KaminoAction): Promise<string> {
    const tx = new Transaction().add(
      ...action.setupIxs,
      ...action.lendingIxs,
      ...action.cleanupIxs
    );

    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: CONFIG.commitment,
    });
  }

  // ========================================================================
  // LIQUIDITY METHODS
  // ========================================================================

  async getLiquidityStrategies(filters?: {
    strategyType?: "NON_PEGGED" | "PEGGED" | "STABLE";
    status?: "LIVE" | "STAGING" | "DEPRECATED";
  }) {
    if (filters) {
      return this.liquidity.getAllStrategiesWithFilters(filters);
    }
    return this.liquidity.getStrategiesWithAddresses();
  }

  async getStrategyInfo(address: PublicKey) {
    const strategy = await this.liquidity.getStrategyByAddress(address);
    if (!strategy) throw new Error("Strategy not found");

    const shareData = await this.liquidity.getStrategyShareData(address);
    const range = await this.liquidity.getStrategyRange(address);

    return {
      sharePrice: shareData.sharePrice,
      totalShares: shareData.totalShares,
      tvl: shareData.totalShares.mul(shareData.sharePrice),
      currentPrice: range.currentPrice,
      lowerPrice: range.lowerPrice,
      upperPrice: range.upperPrice,
      isInRange: range.isInRange,
    };
  }

  async getLiquidityPositions() {
    const strategies = await this.liquidity.getStrategiesWithAddresses();
    const positions = [];

    for (const { address, strategy } of strategies) {
      const kTokenAta = await this.liquidity.getAssociatedTokenAddressAndData(
        strategy.sharesMint,
        this.address
      );

      if (!kTokenAta.exists) continue;

      const balance = await this.liquidity.getTokenAccountBalanceOrZero(
        kTokenAta.address
      );
      if (balance.lte(0)) continue;

      const shareData = await this.liquidity.getStrategyShareData(address);

      positions.push({
        strategy: address.toString(),
        shares: balance,
        value: balance.mul(shareData.sharePrice),
      });
    }

    return positions;
  }

  async depositToStrategy(
    strategyAddress: PublicKey,
    tokenAAmount: Decimal,
    tokenBAmount: Decimal,
    slippageBps: number = 50
  ): Promise<string> {
    const slippage = new Decimal(slippageBps).div(10000);

    const depositIxs = await this.liquidity.deposit(
      strategyAddress,
      this.address,
      tokenAAmount,
      tokenBAmount,
      slippage
    );

    const tx = this.liquidity.createTransactionWithExtraBudget(400000);
    tx.add(...depositIxs);
    await this.liquidity.assignBlockInfoToTransaction(tx);

    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: CONFIG.commitment,
    });
  }

  async withdrawFromStrategy(
    strategyAddress: PublicKey,
    shares: Decimal | "all",
    slippageBps: number = 50
  ): Promise<string> {
    const slippage = new Decimal(slippageBps).div(10000);

    let withdrawIxs;
    if (shares === "all") {
      withdrawIxs = await this.liquidity.withdrawAllShares(
        strategyAddress,
        this.address,
        slippage
      );
    } else {
      withdrawIxs = await this.liquidity.withdraw(
        strategyAddress,
        this.address,
        shares,
        slippage
      );
    }

    const tx = this.liquidity.createTransactionWithExtraBudget(400000);
    tx.add(...withdrawIxs);
    await this.liquidity.assignBlockInfoToTransaction(tx);

    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: CONFIG.commitment,
    });
  }

  // ========================================================================
  // PORTFOLIO OVERVIEW
  // ========================================================================

  async getPortfolioSummary() {
    const prices = await this.getAllPrices();
    const lendingPosition = await this.getLendingPosition();
    const liquidityPositions = await this.getLiquidityPositions();

    const totalLiquidityValue = liquidityPositions.reduce(
      (sum, p) => sum.add(p.value),
      new Decimal(0)
    );

    return {
      // Lending
      lending: {
        deposited: lendingPosition.totalDeposited,
        borrowed: lendingPosition.totalBorrowed,
        netValue: lendingPosition.totalDeposited.sub(
          lendingPosition.totalBorrowed
        ),
        healthFactor: lendingPosition.healthFactor,
        deposits: lendingPosition.deposits,
        borrows: lendingPosition.borrows,
      },

      // Liquidity
      liquidity: {
        totalValue: totalLiquidityValue,
        positions: liquidityPositions,
      },

      // Total
      totalPortfolioValue: lendingPosition.totalDeposited
        .sub(lendingPosition.totalBorrowed)
        .add(totalLiquidityValue),
    };
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  const client = new KaminoClient();
  await client.initialize();

  console.log("\n=== Oracle Prices ===");
  const solPrice = await client.getPrice("SOL");
  console.log("SOL Price:", solPrice.toFixed(2));

  console.log("\n=== Lending Reserves ===");
  const reserves = await client.getLendingReserves();
  for (const r of reserves.slice(0, 5)) {
    console.log(
      `${r.symbol}: Supply ${(r.supplyApy * 100).toFixed(2)}% | ` +
        `Borrow ${(r.borrowApy * 100).toFixed(2)}%`
    );
  }

  console.log("\n=== Lending Position ===");
  const lendingPos = await client.getLendingPosition();
  console.log("Total Deposited:", lendingPos.totalDeposited.toFixed(2), "USD");
  console.log("Total Borrowed:", lendingPos.totalBorrowed.toFixed(2), "USD");
  console.log("Health Factor:", lendingPos.healthFactor.toFixed(2));

  console.log("\n=== Liquidity Positions ===");
  const liqPositions = await client.getLiquidityPositions();
  for (const p of liqPositions) {
    console.log(`Strategy ${p.strategy.slice(0, 8)}...: $${p.value.toFixed(2)}`);
  }

  console.log("\n=== Portfolio Summary ===");
  const summary = await client.getPortfolioSummary();
  console.log("Total Portfolio Value:", summary.totalPortfolioValue.toFixed(2), "USD");

  // Example operations (uncomment to use):
  // await client.deposit("SOL", 0.1);
  // await client.borrow("USDC", 10);
  // await client.repay("USDC", "max");
  // await client.withdraw("SOL", "max");
  // await client.depositToStrategy(strategyAddress, amountA, amountB);
  // await client.withdrawFromStrategy(strategyAddress, "all");
}

if (require.main === module) {
  main().catch(console.error);
}
