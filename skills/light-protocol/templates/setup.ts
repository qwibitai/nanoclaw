/**
 * Light Protocol - Complete Setup Template
 *
 * A ready-to-use template for Light Protocol integration.
 * Copy this file and customize for your project.
 */

import { Rpc, createRpc } from "@lightprotocol/stateless.js";
import {
  createMint,
  mintTo,
  transfer,
  compress,
  decompress,
  compressSplTokenAccount,
  createTokenPool,
  approve,
  revoke,
} from "@lightprotocol/compressed-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // RPC endpoints (use Helius for ZK Compression support)
  RPC_ENDPOINT: process.env.RPC_ENDPOINT || "https://devnet.helius-rpc.com?api-key=YOUR_API_KEY",
  PHOTON_ENDPOINT: process.env.PHOTON_ENDPOINT || process.env.RPC_ENDPOINT || "",

  // Wallet configuration
  WALLET_PATH: process.env.WALLET_PATH || "./keypair.json",
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",

  // Token configuration
  DEFAULT_DECIMALS: 9,

  // Transaction settings
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  TX_CONFIRMATION: "confirmed" as const,

  // Batch settings
  MAX_ACCOUNTS_PER_TX: 4,
  BATCH_DELAY: 500,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load keypair from file or environment
 */
export function loadWallet(): Keypair {
  // Try environment variable first
  if (CONFIG.PRIVATE_KEY) {
    try {
      const secretKey = JSON.parse(CONFIG.PRIVATE_KEY);
      return Keypair.fromSecretKey(Uint8Array.from(secretKey));
    } catch {
      // Try base58 decode
      const bs58 = require("bs58");
      return Keypair.fromSecretKey(bs58.decode(CONFIG.PRIVATE_KEY));
    }
  }

  // Try file
  if (fs.existsSync(CONFIG.WALLET_PATH)) {
    const secretKey = JSON.parse(fs.readFileSync(CONFIG.WALLET_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  }

  throw new Error("No wallet found. Set PRIVATE_KEY env var or provide keypair.json");
}

/**
 * Format lamports as SOL
 */
export function formatSol(lamports: number | bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

/**
 * Format token amount with decimals
 */
export function formatTokens(amount: number | bigint | string, decimals: number = 9): string {
  return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

/**
 * Parse token amount from human-readable
 */
export function parseTokens(amount: number, decimals: number = 9): number {
  return Math.floor(amount * Math.pow(10, decimals));
}

/**
 * Retry wrapper for transactions
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = CONFIG.MAX_RETRIES
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.log(`Attempt ${i + 1}/${maxRetries} failed:`, error.message);

      if (i < maxRetries - 1) {
        await sleep(CONFIG.RETRY_DELAY * (i + 1));
      }
    }
  }

  throw lastError;
}

// ============================================================================
// Light Protocol Client
// ============================================================================

export class LightProtocolClient {
  public rpc: Rpc;
  public payer: Keypair;

  constructor(rpc?: Rpc, payer?: Keypair) {
    this.rpc = rpc || createRpc(CONFIG.RPC_ENDPOINT, CONFIG.PHOTON_ENDPOINT || CONFIG.RPC_ENDPOINT);
    this.payer = payer || loadWallet();
  }

  // --------------------------------------------------------------------------
  // Wallet & Balance Methods
  // --------------------------------------------------------------------------

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async getSolBalance(): Promise<number> {
    return await this.rpc.getBalance(this.payer.publicKey);
  }

  async getCompressedTokenBalance(mint: PublicKey, owner?: PublicKey): Promise<bigint> {
    const ownerKey = owner || this.payer.publicKey;
    const accounts = await this.rpc.getCompressedTokenAccountsByOwner(ownerKey, { mint });
    return accounts.items.reduce((sum, acc) => sum + BigInt(acc.parsed.amount), BigInt(0));
  }

  async getCompressedTokenAccounts(mint?: PublicKey, owner?: PublicKey) {
    const ownerKey = owner || this.payer.publicKey;
    const options = mint ? { mint } : undefined;
    return await this.rpc.getCompressedTokenAccountsByOwner(ownerKey, options);
  }

  // --------------------------------------------------------------------------
  // Mint Methods
  // --------------------------------------------------------------------------

  async createMint(decimals: number = CONFIG.DEFAULT_DECIMALS): Promise<PublicKey> {
    const { mint } = await createMint(
      this.rpc,
      this.payer,
      this.payer.publicKey,
      decimals
    );
    return mint;
  }

  async addTokenPool(existingMint: PublicKey): Promise<string> {
    return await createTokenPool(this.rpc, this.payer, existingMint);
  }

  // --------------------------------------------------------------------------
  // Token Operations
  // --------------------------------------------------------------------------

  async mint(mint: PublicKey, recipient: PublicKey, amount: number): Promise<string> {
    return await mintTo(this.rpc, this.payer, mint, recipient, this.payer, amount);
  }

  async mintBatch(
    mint: PublicKey,
    recipients: PublicKey[],
    amounts: number[]
  ): Promise<string[]> {
    const signatures: string[] = [];

    for (let i = 0; i < recipients.length; i += CONFIG.MAX_ACCOUNTS_PER_TX) {
      const batchRecipients = recipients.slice(i, i + CONFIG.MAX_ACCOUNTS_PER_TX);
      const batchAmounts = amounts.slice(i, i + CONFIG.MAX_ACCOUNTS_PER_TX);

      const sig = await mintTo(
        this.rpc,
        this.payer,
        mint,
        batchRecipients,
        this.payer,
        batchAmounts
      );
      signatures.push(sig);

      if (i + CONFIG.MAX_ACCOUNTS_PER_TX < recipients.length) {
        await sleep(CONFIG.BATCH_DELAY);
      }
    }

    return signatures;
  }

  async transfer(
    mint: PublicKey,
    recipient: PublicKey,
    amount: number,
    sender?: Keypair
  ): Promise<string> {
    const senderKeypair = sender || this.payer;
    return await transfer(this.rpc, this.payer, mint, amount, senderKeypair, recipient);
  }

  // --------------------------------------------------------------------------
  // Compression Operations
  // --------------------------------------------------------------------------

  async compressSpl(
    mint: PublicKey,
    amount: number,
    recipient: PublicKey,
    sourceTokenAccount: PublicKey
  ): Promise<string> {
    return await compress(
      this.rpc,
      this.payer,
      mint,
      amount,
      this.payer,
      recipient,
      sourceTokenAccount
    );
  }

  async compressEntireAccount(
    mint: PublicKey,
    tokenAccount: PublicKey,
    keepAmount?: number
  ): Promise<string> {
    return await compressSplTokenAccount(
      this.rpc,
      this.payer,
      mint,
      this.payer,
      tokenAccount,
      keepAmount
    );
  }

  async decompress(
    mint: PublicKey,
    amount: number,
    splTokenAccount: PublicKey
  ): Promise<string> {
    return await decompress(
      this.rpc,
      this.payer,
      mint,
      amount,
      this.payer,
      splTokenAccount
    );
  }

  // --------------------------------------------------------------------------
  // Delegation
  // --------------------------------------------------------------------------

  async approveDelegate(
    mint: PublicKey,
    delegate: PublicKey,
    amount: number
  ): Promise<string> {
    return await approve(this.rpc, this.payer, mint, amount, this.payer, delegate);
  }

  async revokeDelegate(mint: PublicKey): Promise<string> {
    return await revoke(this.rpc, this.payer, mint, this.payer);
  }

  // --------------------------------------------------------------------------
  // SPL Token Helpers
  // --------------------------------------------------------------------------

  async ensureSplTokenAccount(mint: PublicKey, owner?: PublicKey): Promise<PublicKey> {
    const ownerKey = owner || this.payer.publicKey;
    const ata = await getAssociatedTokenAddress(mint, ownerKey);

    try {
      await getAccount(this.rpc, ata);
    } catch {
      const ix = createAssociatedTokenAccountInstruction(
        this.payer.publicKey,
        ata,
        ownerKey,
        mint
      );
      const tx = new Transaction().add(ix);
      await sendAndConfirmTransaction(this.rpc, tx, [this.payer]);
    }

    return ata;
  }

  // --------------------------------------------------------------------------
  // Indexer Methods
  // --------------------------------------------------------------------------

  async checkIndexerHealth(): Promise<boolean> {
    try {
      await this.rpc.getIndexerHealth();
      return true;
    } catch {
      return false;
    }
  }

  async getIndexerSlot(): Promise<number> {
    const result = await this.rpc.getIndexerSlot();
    return result.slot;
  }
}

// ============================================================================
// Main Example
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Light Protocol - Setup Template");
  console.log("=".repeat(60));

  // Initialize client
  const client = new LightProtocolClient();

  console.log("\nWallet:", client.publicKey.toBase58());

  // Check SOL balance
  const solBalance = await client.getSolBalance();
  console.log("SOL Balance:", formatSol(solBalance), "SOL");

  // Check indexer health
  const isHealthy = await client.checkIndexerHealth();
  console.log("Indexer Health:", isHealthy ? "OK" : "UNHEALTHY");

  if (solBalance < 0.01 * LAMPORTS_PER_SOL) {
    console.log("\nInsufficient SOL balance. Request airdrop:");
    console.log(`solana airdrop 1 ${client.publicKey.toBase58()} --url devnet`);
    return;
  }

  // Example: Create a mint
  console.log("\nCreating compressed token mint...");
  const mint = await client.createMint();
  console.log("Mint:", mint.toBase58());

  // Example: Mint tokens
  console.log("\nMinting tokens...");
  const mintSig = await client.mint(mint, client.publicKey, parseTokens(100));
  console.log("Minted 100 tokens:", mintSig);

  // Example: Check balance
  const balance = await client.getCompressedTokenBalance(mint);
  console.log("Token Balance:", formatTokens(balance), "tokens");

  // Example: Transfer tokens
  const recipient = Keypair.generate().publicKey;
  console.log("\nTransferring to:", recipient.toBase58());
  const transferSig = await client.transfer(mint, recipient, parseTokens(10));
  console.log("Transferred 10 tokens:", transferSig);

  // Final balance
  await sleep(2000);
  const finalBalance = await client.getCompressedTokenBalance(mint);
  console.log("\nFinal Balance:", formatTokens(finalBalance), "tokens");

  console.log("\n" + "=".repeat(60));
  console.log("Setup Complete! Ready to build.");
  console.log("=".repeat(60));
}

// Run if executed directly
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
