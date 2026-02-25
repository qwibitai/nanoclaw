/**
 * Marginfi Collateralized Borrowing Setup Template
 *
 * Setup for collateralized borrowing operations:
 * - Deposit collateral
 * - Borrow against collateral
 * - Monitor health
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
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import * as fs from "fs";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const CONFIG = getConfig("production");

async function setupCollateralBorrow() {
  const connection = new Connection(RPC_URL, "confirmed");
  const walletSecret = JSON.parse(fs.readFileSync("./keypair.json", "utf-8"));
  const keypair = Keypair.fromSecretKey(Buffer.from(walletSecret));
  const walletAdapter = new NodeWallet(keypair);

  console.log("Loading Marginfi...");
  const client = await MarginfiClient.fetch(CONFIG, walletAdapter, connection);

  // Get account
  const accounts = await MarginfiAccount.findAllByOwner(connection, keypair.publicKey);
  if (accounts.length === 0) throw new Error("No account found");
  const account = accounts[0];

  console.log("Account:", account.publicKey.toBase58());

  // Step 1: Deposit SOL as collateral
  console.log("\n[1/3] Depositing SOL as collateral...");
  const solBank = client.getBankByTokenSymbol("SOL");
    if (solBank) {
      // Use UI-denominated amount (5 SOL)
      const sig = await account.deposit(5, solBank.address);
      console.log("✓ Deposited 5 SOL", sig);
  }

  // Step 2: Borrow USDC against collateral
  console.log("\n[2/3] Borrowing USDC against collateral...");
  const usdcBank = client.getBankByTokenSymbol("USDC");
  if (usdcBank) {
    // Check health components before borrowing
    await account.reload();
    const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
    const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
    const maxBorrow = new Decimal(account.computeMaxBorrowForBank(usdcBank.address).toString());
    console.log("Net health (maint):", netHealth.toFixed(4));
    console.log("Max borrow (bank):", maxBorrow.toFixed(2));

    // Borrow portion of available
    const borrowAmount = maxBorrow.mul(0.5); // 50% of capacity
    const sigs = await account.borrow(borrowAmount.toNumber(), usdcBank.address);
    console.log(`✓ Borrowed ${borrowAmount.toFixed(2)} USDC`, sigs);
  }

  // Step 3: Monitor position
  console.log("\n[3/3] Position Summary");
  await account.reload();

  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);

  console.log("\nAssets:");
  for (const balance of account.balances) {
    if (balance.isAsset) {
      const value = balance.amount.mul(balance.price);
      totalAssets = totalAssets.plus(value);
      console.log(`  ${balance.bankLabel}: $${value.toFixed(2)}`);
    }
  }

  console.log("\nLiabilities:");
  for (const balance of account.balances) {
    if (!balance.isAsset) {
      const value = balance.amount.mul(balance.price);
      totalLiabilities = totalLiabilities.plus(value);
      console.log(`  ${balance.bankLabel}: $${value.toFixed(2)}`);
    }
  }

  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  console.log("\nNet health (maint):", netHealth.toFixed(4));
}

setupCollateralBorrow().catch(console.error);
