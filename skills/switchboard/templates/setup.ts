/**
 * Switchboard Complete Setup Template
 *
 * A comprehensive starter template for integrating Switchboard
 * oracle feeds into your Solana application.
 *
 * Features:
 * - Full SDK initialization
 * - Pull feed operations
 * - Oracle quote support
 * - Surge real-time streaming
 * - Error handling and retry logic
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  PullFeed,
  CrossbarClient,
  OracleQuote,
  SwitchboardSurge,
  asV0Tx,
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION - Customize these values
// ============================================================================

const CONFIG = {
  // Network: "mainnet" | "devnet"
  network: (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet",

  // RPC endpoint
  rpcEndpoint: process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",

  // Wallet configuration
  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  // Crossbar endpoint
  crossbarEndpoint: "https://crossbar.switchboard.xyz",

  // Surge WebSocket endpoint
  surgeEndpoint: "wss://surge.switchboard.xyz",

  // Queue addresses
  queues: {
    mainnet: new web3.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"),
    devnet: new web3.PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"),
  },

  // Transaction settings
  defaultComputeUnits: 400_000,
  defaultComputeUnitPrice: 200_000,
  defaultNumSignatures: 3,

  // Retry settings
  maxRetries: 3,
  retryDelay: 1000,

  // Staleness threshold (slots)
  maxStalenessSlots: 100,
};

// ============================================================================
// TYPES
// ============================================================================

export interface SwitchboardClientConfig {
  network?: "mainnet" | "devnet";
  rpcEndpoint?: string;
  walletPath?: string;
  wallet?: web3.Keypair;
}

export interface FeedUpdateOptions {
  numSignatures?: number;
  computeUnitPrice?: number;
  computeUnitLimitMultiple?: number;
}

export interface FeedValue {
  value: bigint;
  decimalValue: number;
  slot: number;
  staleness: number;
  isStale: boolean;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Load wallet from file
 */
function loadWallet(path: string): web3.Keypair {
  const resolvedPath = path.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = CONFIG.maxRetries,
  delay: number = CONFIG.retryDelay
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      console.log(`Attempt ${i + 1} failed: ${error.message}`);

      if (i < maxRetries - 1) {
        await sleep(delay * (i + 1)); // Exponential backoff
      }
    }
  }

  throw lastError;
}

/**
 * Get program ID for network
 */
function getProgramId(network: "mainnet" | "devnet"): web3.PublicKey {
  return network === "mainnet" ? ON_DEMAND_MAINNET_PID : ON_DEMAND_DEVNET_PID;
}

/**
 * Convert scaled value to decimal (18 decimals)
 */
function toDecimal(value: bigint, decimals: number = 18): number {
  const divisor = BigInt(10 ** decimals);
  const intPart = value / divisor;
  const fracPart = value % divisor;
  return Number(intPart) + Number(fracPart) / Number(divisor);
}

// ============================================================================
// SWITCHBOARD CLIENT CLASS
// ============================================================================

export class SwitchboardClient {
  // Public properties
  public readonly connection: web3.Connection;
  public readonly wallet: web3.Keypair;
  public readonly provider: AnchorProvider;
  public readonly network: "mainnet" | "devnet";
  public readonly crossbar: CrossbarClient;
  public readonly queue: web3.PublicKey;

  // Private properties
  private program: Program | null = null;
  private surge: SwitchboardSurge | null = null;

  constructor(config: SwitchboardClientConfig = {}) {
    this.network = config.network || CONFIG.network;

    // Load or use provided wallet
    this.wallet = config.wallet || loadWallet(config.walletPath || CONFIG.walletPath);

    // Setup connection
    const rpcEndpoint = config.rpcEndpoint || CONFIG.rpcEndpoint;
    this.connection = new web3.Connection(rpcEndpoint, "confirmed");

    // Setup provider
    this.provider = new AnchorProvider(
      this.connection,
      new Wallet(this.wallet),
      { commitment: "confirmed" }
    );

    // Setup Crossbar
    this.crossbar = new CrossbarClient(CONFIG.crossbarEndpoint);

    // Get queue
    this.queue = CONFIG.queues[this.network];
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize the Switchboard program
   */
  async initialize(): Promise<void> {
    const programId = getProgramId(this.network);
    this.program = await Program.at(programId, this.provider);
    console.log("Switchboard initialized on", this.network);
  }

  /**
   * Get the program instance
   */
  getProgram(): Program {
    if (!this.program) {
      throw new Error("Client not initialized. Call initialize() first.");
    }
    return this.program;
  }

  // --------------------------------------------------------------------------
  // Feed Operations
  // --------------------------------------------------------------------------

  /**
   * Create a PullFeed reference
   */
  createFeed(feedPubkey: web3.PublicKey | string): PullFeed {
    const pubkey =
      typeof feedPubkey === "string"
        ? new web3.PublicKey(feedPubkey)
        : feedPubkey;
    return new PullFeed(this.getProgram(), pubkey);
  }

  /**
   * Update a feed with fresh oracle data
   */
  async updateFeed(
    feedPubkey: web3.PublicKey | string,
    options: FeedUpdateOptions = {}
  ): Promise<string> {
    const feed = this.createFeed(feedPubkey);

    // Fetch update instruction
    const { pullIx, numSuccess, luts } = await feed.fetchUpdateIx({
      crossbarClient: this.crossbar,
      chain: "solana",
      network: this.network,
      numSignatures: options.numSignatures || CONFIG.defaultNumSignatures,
    });

    if (numSuccess < 1) {
      throw new Error("No oracle responses received");
    }

    // Build transaction
    const tx = await asV0Tx({
      connection: this.connection,
      ixs: [pullIx],
      signers: [this.wallet],
      computeUnitPrice:
        options.computeUnitPrice || CONFIG.defaultComputeUnitPrice,
      computeUnitLimitMultiple: options.computeUnitLimitMultiple || 1.3,
      lookupTables: luts,
    });

    // Send and confirm
    const signature = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(signature, "confirmed");

    return signature;
  }

  /**
   * Read current feed value
   */
  async readFeed(feedPubkey: web3.PublicKey | string): Promise<FeedValue> {
    const feed = this.createFeed(feedPubkey);
    const feedData = await feed.loadData();
    const currentSlot = await this.connection.getSlot();

    const value = BigInt(feedData.value.toString());
    const slot = feedData.lastUpdatedSlot;
    const staleness = currentSlot - slot;

    return {
      value,
      decimalValue: toDecimal(value),
      slot,
      staleness,
      isStale: staleness > CONFIG.maxStalenessSlots,
    };
  }

  /**
   * Update and read feed in one operation
   */
  async updateAndReadFeed(
    feedPubkey: web3.PublicKey | string,
    options: FeedUpdateOptions = {}
  ): Promise<{ signature: string; value: FeedValue }> {
    const signature = await this.updateFeed(feedPubkey, options);
    const value = await this.readFeed(feedPubkey);
    return { signature, value };
  }

  // --------------------------------------------------------------------------
  // Oracle Quotes
  // --------------------------------------------------------------------------

  /**
   * Derive canonical quote account for feed hashes
   */
  deriveQuoteAccount(
    feedHashes: string[],
    programId?: web3.PublicKey
  ): web3.PublicKey {
    return OracleQuote.getCanonicalPubkey(this.queue, feedHashes, programId);
  }

  // --------------------------------------------------------------------------
  // Surge Streaming
  // --------------------------------------------------------------------------

  /**
   * Initialize Surge streaming client
   */
  initializeSurge(apiKey?: string): SwitchboardSurge {
    this.surge = new SwitchboardSurge({
      apiKey,
      gatewayUrl: CONFIG.surgeEndpoint,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectDelay: 1000,
    });
    return this.surge;
  }

  /**
   * Get Surge client
   */
  getSurge(): SwitchboardSurge {
    if (!this.surge) {
      throw new Error("Surge not initialized. Call initializeSurge() first.");
    }
    return this.surge;
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get wallet balance
   */
  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / web3.LAMPORTS_PER_SOL;
  }

  /**
   * Check connection health
   */
  async checkHealth(): Promise<{ healthy: boolean; slot: number }> {
    try {
      const slot = await this.connection.getSlot();
      return { healthy: true, slot };
    } catch {
      return { healthy: false, slot: 0 };
    }
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Client Template");
  console.log("=".repeat(60));

  // Initialize client
  const client = new SwitchboardClient();
  await client.initialize();

  // Check health
  const health = await client.checkHealth();
  console.log("\nConnection health:", health);

  // Get balance
  const balance = await client.getBalance();
  console.log("Wallet balance:", balance, "SOL");

  console.log("\n--- Example Operations ---\n");

  // Example: Update and read a feed
  console.log("To update and read a feed:");
  console.log(`
const feedPubkey = "YOUR_FEED_PUBKEY";

// Update feed
const signature = await client.updateFeed(feedPubkey);
console.log("Updated:", signature);

// Read feed
const value = await client.readFeed(feedPubkey);
console.log("Value:", value.decimalValue);
console.log("Stale:", value.isStale);
`);

  // Example: Oracle quotes
  console.log("To use Oracle Quotes:");
  console.log(`
const feedHashes = ["0x...", "0x..."];
const quotePubkey = client.deriveQuoteAccount(feedHashes);
console.log("Quote account:", quotePubkey.toBase58());
`);

  // Example: Surge streaming
  console.log("To stream prices with Surge:");
  console.log(`
const surge = client.initializeSurge();
surge.on("data", (data) => {
  console.log(data.symbol, data.price);
});
surge.subscribe(["SOL/USD", "BTC/USD"]);
`);

  console.log("=".repeat(60));
  console.log("Template ready for use!");
  console.log("=".repeat(60));
}

// Run if executed directly
main().catch(console.error);

// Export for use as module
export {
  CONFIG,
  loadWallet,
  sleep,
  withRetry,
  getProgramId,
  toDecimal,
};
