/**
 * Marginfi Full Integration Template
 *
 * Complete example integrating Marginfi functionality:
 * - Account creation and management
 * - Deposits and withdrawals
 * - Borrowing and repayments
 * - Health checks and monitoring
 */

import {
  MarginfiClient,
  MarginfiAccount,
  getConfig,
  MarginRequirementType,
} from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
  Commitment,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  commitment: "confirmed" as Commitment,
  // Use official SDK config instead of a hardcoded (possibly incorrect) group address
  groupConfig: getConfig("production"),
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// MARGINFI FULL CLIENT
// ============================================================================

export class MarginfiFullClient {
  private connection: Connection;
  private wallet: Keypair;
  private walletAdapter: any;
  private client: MarginfiClient | null = null;
  private account: MarginfiAccount | null = null;

  constructor() {
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);

    // Load wallet from path or environment
    let keypairData: Uint8Array;
    if (fs.existsSync(CONFIG.walletPath)) {
      const secret = JSON.parse(fs.readFileSync(CONFIG.walletPath, "utf-8"));
      keypairData = Buffer.from(secret);
    } else if (process.env.WALLET_KEYPAIR) {
      keypairData = Buffer.from(JSON.parse(process.env.WALLET_KEYPAIR));
    } else {
      throw new Error("Wallet keypair not found");
    }

    this.wallet = Keypair.fromSecretKey(keypairData);
    this.walletAdapter = new NodeWallet(this.wallet);
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  async initialize(): Promise<void> {
    console.log("Initializing Marginfi client...");
    console.log("Wallet:", this.wallet.publicKey.toBase58());

    // Load client
    this.client = await MarginfiClient.fetch(CONFIG.groupConfig, this.walletAdapter, this.connection);

    console.log(`✓ Loaded ${this.client.banks.size} banks`);

    // Load or create account
    await this.loadOrCreateAccount();
  }

  private async loadOrCreateAccount(): Promise<void> {
    const accounts = await MarginfiAccount.findAllByOwner(this.connection, this.wallet.publicKey);
    if (accounts.length > 0) {
      this.account = accounts[0];
      console.log(`✓ Loaded existing account: ${this.account.publicKey.toBase58()}`);
    } else {
      console.log("Creating new account...");
      this.account = await this.client!.createMarginfiAccount();
      console.log(`✓ Account created: ${this.account.address.toBase58()}`);
    }
  }

  // ========================================================================
  // ACCOUNT OPERATIONS
  // ========================================================================

  async deposit(bankLabel: string, amountTokens: number): Promise<void> {
    if (!this.client || !this.account) throw new Error("Not initialized");

    const bank = this.client.getBankByTokenSymbol(bankLabel);
    if (!bank) throw new Error(`Bank ${bankLabel} not found`);

    console.log(`\nDepositing ${amountTokens} ${bankLabel}...`);
    const sig = await this.account.deposit(amountTokens, bank.address);
    await this.account.reload();
    console.log(`✓ Deposit successful: ${sig}`);
  }

  async withdraw(bankLabel: string, amountTokens: number): Promise<void> {
    if (!this.client || !this.account) throw new Error("Not initialized");

    const bank = this.client.getBankByTokenSymbol(bankLabel);
    if (!bank) throw new Error(`Bank ${bankLabel} not found`);

    console.log(`\nWithdrawing ${amountTokens} ${bankLabel}...`);
    const sigs = await this.account.withdraw(amountTokens, bank.address, false);
    await this.account.reload();
    console.log(`✓ Withdrawal successful: ${sigs}`);
  }

  async borrow(bankLabel: string, amountTokens: number): Promise<void> {
    if (!this.client || !this.account) throw new Error("Not initialized");

    const bank = this.client.getBankByTokenSymbol(bankLabel);
    if (!bank) throw new Error(`Bank ${bankLabel} not found`);

    // Check health components
    const { assets, liabilities } = this.account.computeHealthComponents(MarginRequirementType.Maintenance);
    const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
    const freeCollateral = new Decimal(this.account.computeFreeCollateral().toString());
    if (netHealth.lte(0) || freeCollateral.lte(0)) {
      throw new Error("Insufficient collateral to borrow");
    }

    console.log(`\nBorrowing ${amountTokens} ${bankLabel}...`);
    console.log("Net health (maint) before:", netHealth.toFixed(4));
    console.log("Free collateral:", freeCollateral.toFixed(4));
    const sigs = await this.account.borrow(amountTokens, bank.address);
    await this.account.reload();
    const { assets: newAssets, liabilities: newLiabilities } = this.account.computeHealthComponents(MarginRequirementType.Maintenance);
    const newHealth = new Decimal(newAssets.toString()).minus(new Decimal(newLiabilities.toString()));
    console.log(`✓ Borrow successful: ${sigs}`);
    console.log("Net health (maint) after:", newHealth.toFixed(4));
  }

  async repay(bankLabel: string, amount: number | "max"): Promise<void> {
    if (!this.client || !this.account) throw new Error("Not initialized");

    const bank = this.client.getBankByTokenSymbol(bankLabel);
    if (!bank) throw new Error(`Bank ${bankLabel} not found`);

    console.log(`\nRepaying ${amount} ${bankLabel}...`);
    let sigs;
    if (amount === "max") {
      sigs = await this.account.repay(0, bank.address, true);
    } else {
      sigs = await this.account.repay(amount as any, bank.address, false);
    }

    await this.account.reload();
    console.log(`✓ Repayment successful: ${sigs}`);
  }

  // ========================================================================
  // PORTFOLIO MANAGEMENT
  // ========================================================================

  async printPortfolio(): Promise<void> {
    if (!this.account || !this.client) throw new Error("Not initialized");

    await this.account.reload();

    console.log("\n=== Portfolio ===");

    let totalAssets = new Decimal(0);
    let totalLiabilities = new Decimal(0);

    console.log("\nAssets:");
    for (const balance of this.account.balances) {
      if (balance.isAsset) {
        const value = balance.amount.mul(balance.price);
        totalAssets = totalAssets.plus(value);
        console.log(
          `  ${balance.bankLabel}: ${balance.amount.toFixed(2)} @ $${balance.price.toFixed(2)} = $${value.toFixed(2)}`
        );
      }
    }

    console.log("\nLiabilities:");
    for (const balance of this.account.balances) {
      if (!balance.isAsset) {
        const value = balance.amount.mul(balance.price);
        totalLiabilities = totalLiabilities.plus(value);
        console.log(
          `  ${balance.bankLabel}: ${balance.amount.toFixed(2)} @ $${balance.price.toFixed(2)} = $${value.toFixed(2)}`
        );
      }
    }

    console.log(`\nTotal Assets: $${totalAssets.toFixed(2)}`);
    console.log(`Total Liabilities: $${totalLiabilities.toFixed(2)}`);
    console.log(`Net Worth: $${totalAssets.minus(totalLiabilities).toFixed(2)}`);
  }

  async printHealth(): Promise<void> {
    if (!this.account) throw new Error("Not initialized");

    const { assets, liabilities } = this.account.computeHealthComponents(MarginRequirementType.Maintenance);
    const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
    const freeCollateral = new Decimal(this.account.computeFreeCollateral().toString());

    console.log("\n=== Health Status ===");
    console.log("Net health (maint):", netHealth.toFixed(4));
    console.log("Free collateral:", freeCollateral.toFixed(4));
  }

  async printBanks(): Promise<void> {
    if (!this.client) throw new Error("Not initialized");

    console.log("\n=== Available Banks ===");

      for (const bank of this.client.banks.values()) {
        const symbol = bank.tokenSymbol ?? bank.mint.toBase58();

        // Convert on-chain/native quantities to UI units using mint decimals
        const totalAssetsUi = new BN(bank.getTotalAssetQuantity().toString())
          .dividedBy(new BN(10).pow(bank.mintDecimals))
          .toFixed(2);
        const totalLiabilitiesUi = new BN(bank.getTotalLiabilityQuantity().toString())
          .dividedBy(new BN(10).pow(bank.mintDecimals))
          .toFixed(2);

        const rates = bank.computeInterestRates();
        const lendingApy = new BN(rates.lendingRate.toString()).times(100).toFixed(2);
        const borrowingApy = new BN(rates.borrowingRate.toString()).times(100).toFixed(2);
        const utilization = new BN(bank.computeUtilizationRate().toString()).times(100).toFixed(2);

        console.log(`\n${symbol}:`);
        console.log(`  Total Deposits: ${totalAssetsUi} ${symbol}`);
        console.log(`  Total Borrows: ${totalLiabilitiesUi} ${symbol}`);
        console.log(`  Supply APY: ${lendingApy}%`);
        console.log(`  Borrow APY: ${borrowingApy}%`);
        console.log(`  Utilization: ${utilization}%`);
      }
  }

  // ========================================================================
  // UTILITIES
  // ========================================================================

  getClient(): MarginfiClient {
    if (!this.client) throw new Error("Client not initialized");
    return this.client;
  }

  getAccount(): MarginfiAccount {
    if (!this.account) throw new Error("Account not initialized");
    return this.account;
  }

  getConnection(): Connection {
    return this.connection;
  }

  getWallet(): Keypair {
    return this.wallet;
  }
}

// ============================================================================
// DEMO
// ============================================================================

async function main() {
  try {
    const marginfi = new MarginfiFullClient();
    await marginfi.initialize();

    // Show banks
    await marginfi.printBanks();

    // Show initial health
    await marginfi.printHealth();

    // Show portfolio
    await marginfi.printPortfolio();

    console.log("\n✓ Full integration example completed");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
