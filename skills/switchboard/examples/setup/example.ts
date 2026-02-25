/**
 * Switchboard Basic Setup Example
 *
 * This example demonstrates how to set up the Switchboard SDK
 * and initialize connections for oracle operations.
 */

import { web3, AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  PullFeed,
  CrossbarClient,
  ON_DEMAND_MAINNET_PID,
  ON_DEMAND_DEVNET_PID,
} from "@switchboard-xyz/on-demand";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Network configuration
  network: (process.env.SOLANA_NETWORK as "mainnet" | "devnet") || "devnet",

  // RPC endpoints
  rpcEndpoints: {
    mainnet: process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com",
    devnet: process.env.DEVNET_RPC || "https://api.devnet.solana.com",
  },

  // Crossbar endpoint for oracle communication
  crossbarEndpoint: "https://crossbar.switchboard.xyz",

  // Wallet path
  walletPath: process.env.WALLET_PATH || "~/.config/solana/id.json",

  // Default queue addresses
  queues: {
    mainnet: new web3.PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w"),
    devnet: new web3.PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"),
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Load wallet from file path
 */
function loadWallet(path: string): web3.Keypair {
  const resolvedPath = path.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return web3.Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Get program ID based on network
 */
function getProgramId(network: "mainnet" | "devnet"): web3.PublicKey {
  return network === "mainnet" ? ON_DEMAND_MAINNET_PID : ON_DEMAND_DEVNET_PID;
}

/**
 * Get default queue for network
 */
function getQueue(network: "mainnet" | "devnet"): web3.PublicKey {
  return CONFIG.queues[network];
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SWITCHBOARD CLIENT CLASS
// ============================================================================

interface SwitchboardConfig {
  network: "mainnet" | "devnet";
  wallet: web3.Keypair;
  rpcEndpoint?: string;
}

export class SwitchboardClient {
  public readonly connection: web3.Connection;
  public readonly wallet: web3.Keypair;
  public readonly provider: AnchorProvider;
  public readonly network: "mainnet" | "devnet";
  public readonly crossbar: CrossbarClient;
  public readonly queue: web3.PublicKey;

  private program: Program | null = null;

  constructor(config: SwitchboardConfig) {
    this.network = config.network;
    this.wallet = config.wallet;

    const rpcEndpoint =
      config.rpcEndpoint || CONFIG.rpcEndpoints[config.network];
    this.connection = new web3.Connection(rpcEndpoint, "confirmed");

    this.provider = new AnchorProvider(
      this.connection,
      new Wallet(this.wallet),
      { commitment: "confirmed" }
    );

    this.crossbar = new CrossbarClient(CONFIG.crossbarEndpoint);
    this.queue = getQueue(config.network);
  }

  /**
   * Initialize the Switchboard program
   */
  async initialize(): Promise<void> {
    const programId = getProgramId(this.network);
    this.program = await Program.at(programId, this.provider);
    console.log("Switchboard program loaded:", programId.toBase58());
  }

  /**
   * Get the Switchboard program instance
   */
  getProgram(): Program {
    if (!this.program) {
      throw new Error("Program not initialized. Call initialize() first.");
    }
    return this.program;
  }

  /**
   * Create a PullFeed instance for a given feed address
   */
  createFeed(feedPubkey: web3.PublicKey): PullFeed {
    return new PullFeed(this.getProgram(), feedPubkey);
  }

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
  async checkHealth(): Promise<boolean> {
    try {
      const slot = await this.connection.getSlot();
      console.log("Current slot:", slot);
      return true;
    } catch (error) {
      console.error("Health check failed:", error);
      return false;
    }
  }
}

// ============================================================================
// MAIN EXAMPLE
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("Switchboard Setup Example");
  console.log("=".repeat(60));

  // Load wallet
  const wallet = loadWallet(CONFIG.walletPath);
  console.log("\nWallet loaded:", wallet.publicKey.toBase58());

  // Initialize client
  const client = new SwitchboardClient({
    network: CONFIG.network,
    wallet,
  });

  // Initialize program
  await client.initialize();

  // Check connection health
  console.log("\nChecking connection health...");
  const isHealthy = await client.checkHealth();
  console.log("Connection healthy:", isHealthy);

  // Get wallet balance
  const balance = await client.getBalance();
  console.log("Wallet balance:", balance, "SOL");

  // Display configuration
  console.log("\n" + "=".repeat(60));
  console.log("Configuration Summary");
  console.log("=".repeat(60));
  console.log("Network:", CONFIG.network);
  console.log("Queue:", client.queue.toBase58());
  console.log("Crossbar:", CONFIG.crossbarEndpoint);
  console.log("Program:", getProgramId(CONFIG.network).toBase58());

  console.log("\nSetup complete! Ready to use Switchboard.");
}

// Run if executed directly
main().catch(console.error);

// Export for use in other examples
export { CONFIG, loadWallet, getProgramId, getQueue, sleep };
