/**
 * Marginfi Lending Setup Template
 *
 * Basic setup for lending operations:
 * - Account initialization
 * - Deposit operations
 * - Portfolio monitoring
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

async function setupLending() {
  // Setup connection and wallet
  const connection = new Connection(RPC_URL, "confirmed");
  const walletSecret = JSON.parse(fs.readFileSync("./keypair.json", "utf-8"));
  const wallet = Keypair.fromSecretKey(Buffer.from(walletSecret));
  const walletAdapter = new NodeWallet(wallet);

  console.log("Loading Marginfi...");
  const client = await MarginfiClient.fetch(CONFIG, walletAdapter, connection);

  // Get or create account
  let accounts = await MarginfiAccount.findAllByOwner(connection, wallet.publicKey);
  let account: MarginfiAccount;

  if (accounts.length === 0) {
    console.log("Creating account...");
    account = await client.createMarginfiAccount();
    console.log("Account created:", account.address.toBase58());
  } else {
    account = accounts[0];
  }

  console.log("Account:", account.publicKey.toBase58());

  // Deposit SOL
  console.log("\nDepositing SOL...");
  const solBank = client.getBankByTokenSymbol("SOL");
  if (solBank) {
    // Use UI-denominated amount (1 SOL)
    const sig = await account.deposit(1, solBank.address);
    console.log("SOL deposited:", sig);
  }

  // Deposit USDC
  console.log("Depositing USDC...");
  const usdcBank = client.getBankByTokenSymbol("USDC");
  if (usdcBank) {
    const sig = await account.deposit(1000, usdcBank.address);
    console.log("USDC deposited:", sig);
  }

  // Show portfolio
  await account.reload();
  console.log("\n=== Portfolio ===");
  for (const balance of account.balances) {
    if (balance.isAsset) {
      console.log(`${balance.bankLabel}: ${balance.amount.toString()}`);
    }
  }

  // Show health components
  const { assets, liabilities } = account.computeHealthComponents(MarginRequirementType.Maintenance);
  const netHealth = new Decimal(assets.toString()).minus(new Decimal(liabilities.toString()));
  const freeCollateral = new Decimal(account.computeFreeCollateral().toString());
  console.log("\nNet health (maint):", netHealth.toFixed(4));
  console.log("Free collateral:", freeCollateral.toFixed(4));
}

setupLending().catch(console.error);
