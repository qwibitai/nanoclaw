/**
 * Pyth Network Client Template
 *
 * Production-ready client for fetching and posting Pyth prices.
 * Copy this file and customize for your project.
 *
 * Usage:
 * 1. Set your configuration below
 * 2. Install dependencies: npm install @pythnetwork/hermes-client @pythnetwork/pyth-solana-receiver @solana/web3.js
 * 3. Run with: npx ts-node pyth-client.ts
 */

import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Hermes API endpoint
  hermesEndpoint: "https://hermes.pyth.network",

  // Solana connection
  solanaRpc: process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com",

  // Default maximum price age in seconds
  maxPriceAgeSecs: 60,

  // Default maximum confidence ratio (basis points)
  maxConfidenceBps: 200, // 2%

  // Priority fee in microlamports
  priorityFeeMicroLamports: 50000,
};

// ============================================================================
// PRICE FEED IDS
// ============================================================================

export const PRICE_FEEDS = {
  // Cryptocurrencies
  BTC_USD: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH_USD: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL_USD: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BNB_USD: "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
  AVAX_USD: "0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",

  // Stablecoins
  USDC_USD: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT_USD: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",

  // Solana Ecosystem
  JTO_USD: "0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  JUP_USD: "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  BONK_USD: "0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF_USD: "0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  RAY_USD: "0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a",

  // DeFi
  LINK_USD: "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  UNI_USD: "0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501",
  AAVE_USD: "0x2b9ab1e972a281585084148ba1389800799bd4be63b957507db1349314e47445",

  // Commodities
  XAU_USD: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  XAG_USD: "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
} as const;

// ============================================================================
// TYPES
// ============================================================================

export interface PriceData {
  feedId: string;
  price: number;
  confidence: number;
  confidencePercent: number;
  publishTime: Date;
  age: number;
  emaPrice?: number;
  emaConfidence?: number;
}

export interface PriceValidationOptions {
  maxAgeSecs?: number;
  maxConfidenceBps?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface PostPriceOptions {
  shardId?: number;
  closeUpdateAccounts?: boolean;
  computeUnitPriceMicroLamports?: number;
}

// ============================================================================
// PYTH CLIENT
// ============================================================================

export class PythClient {
  private hermesClient: HermesClient;
  private connection: Connection;
  private pythReceiver: PythSolanaReceiver | null = null;

  constructor(
    options?: {
      hermesEndpoint?: string;
      solanaRpc?: string;
      wallet?: Keypair;
    }
  ) {
    this.hermesClient = new HermesClient(
      options?.hermesEndpoint || CONFIG.hermesEndpoint
    );
    this.connection = new Connection(
      options?.solanaRpc || CONFIG.solanaRpc,
      "confirmed"
    );

    if (options?.wallet) {
      this.pythReceiver = new PythSolanaReceiver({
        connection: this.connection,
        wallet: options.wallet,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Price Fetching
  // --------------------------------------------------------------------------

  /**
   * Get latest price for a single feed
   */
  async getPrice(feedId: string): Promise<PriceData> {
    const prices = await this.getPrices([feedId]);
    const price = prices.get(feedId);
    if (!price) {
      throw new Error(`No price found for feed: ${feedId}`);
    }
    return price;
  }

  /**
   * Get latest prices for multiple feeds
   */
  async getPrices(feedIds: string[]): Promise<Map<string, PriceData>> {
    const updates = await this.hermesClient.getLatestPriceUpdates(feedIds, {
      parsed: true,
    });

    const priceMap = new Map<string, PriceData>();
    const now = Math.floor(Date.now() / 1000);

    for (const update of updates.parsed || []) {
      const { price, conf, expo, publish_time } = update.price;
      const priceNum = Number(price) * Math.pow(10, expo);
      const confNum = Number(conf) * Math.pow(10, expo);

      const priceData: PriceData = {
        feedId: "0x" + update.id,
        price: priceNum,
        confidence: confNum,
        confidencePercent: (confNum / Math.abs(priceNum)) * 100,
        publishTime: new Date(publish_time * 1000),
        age: now - publish_time,
      };

      if (update.ema_price) {
        priceData.emaPrice =
          Number(update.ema_price.price) * Math.pow(10, update.ema_price.expo);
        priceData.emaConfidence =
          Number(update.ema_price.conf) * Math.pow(10, update.ema_price.expo);
      }

      priceMap.set("0x" + update.id, priceData);
    }

    return priceMap;
  }

  /**
   * Get validated price with checks
   */
  async getValidatedPrice(
    feedId: string,
    options: PriceValidationOptions = {}
  ): Promise<PriceData> {
    const price = await this.getPrice(feedId);
    this.validatePrice(price, options);
    return price;
  }

  /**
   * Validate a price against criteria
   */
  validatePrice(price: PriceData, options: PriceValidationOptions = {}): void {
    const maxAge = options.maxAgeSecs ?? CONFIG.maxPriceAgeSecs;
    const maxConfBps = options.maxConfidenceBps ?? CONFIG.maxConfidenceBps;

    // Check staleness
    if (price.age > maxAge) {
      throw new Error(
        `Price too stale: ${price.age}s old (max: ${maxAge}s)`
      );
    }

    // Check confidence
    const confBps = price.confidencePercent * 100;
    if (confBps > maxConfBps) {
      throw new Error(
        `Confidence too high: ${price.confidencePercent.toFixed(2)}% (max: ${maxConfBps / 100}%)`
      );
    }

    // Check bounds
    if (options.minPrice !== undefined && price.price < options.minPrice) {
      throw new Error(`Price below minimum: ${price.price} < ${options.minPrice}`);
    }

    if (options.maxPrice !== undefined && price.price > options.maxPrice) {
      throw new Error(`Price above maximum: ${price.price} > ${options.maxPrice}`);
    }
  }

  // --------------------------------------------------------------------------
  // Binary Data for On-Chain
  // --------------------------------------------------------------------------

  /**
   * Get binary price update data for posting on-chain
   */
  async getPriceUpdateData(feedIds: string[]): Promise<string[]> {
    const updates = await this.hermesClient.getLatestPriceUpdates(feedIds);
    return updates.binary.data;
  }

  // --------------------------------------------------------------------------
  // Posting to Solana
  // --------------------------------------------------------------------------

  /**
   * Build transactions to post price updates to Solana
   */
  async buildPostPriceTransactions(
    feedIds: string[],
    consumerInstructions?: (accounts: { priceUpdateAccounts: PublicKey[] }) => TransactionInstruction[],
    options: PostPriceOptions = {}
  ): Promise<VersionedTransaction[]> {
    if (!this.pythReceiver) {
      throw new Error("Wallet required for posting prices. Initialize with wallet option.");
    }

    // Get price update data
    const priceUpdateData = await this.getPriceUpdateData(feedIds);

    // Build transaction
    const builder = this.pythReceiver.newTransactionBuilder({
      shardId: options.shardId ?? 0,
      closeUpdateAccounts: options.closeUpdateAccounts ?? true,
    });

    await builder.addPostPriceUpdates(priceUpdateData);

    if (consumerInstructions) {
      builder.addPriceConsumerInstructions(consumerInstructions);
    }

    const transactions = await builder.buildVersionedTransactions({
      computeUnitPriceMicroLamports:
        options.computeUnitPriceMicroLamports ?? CONFIG.priorityFeeMicroLamports,
    });

    return transactions;
  }

  /**
   * Post price updates to Solana and return signatures
   */
  async postPriceUpdates(
    feedIds: string[],
    consumerInstructions?: (accounts: { priceUpdateAccounts: PublicKey[] }) => TransactionInstruction[],
    options: PostPriceOptions = {}
  ): Promise<string[]> {
    const transactions = await this.buildPostPriceTransactions(
      feedIds,
      consumerInstructions,
      options
    );

    const signatures: string[] = [];

    for (const tx of transactions) {
      const signature = await this.connection.sendTransaction(tx);
      await this.connection.confirmTransaction(signature);
      signatures.push(signature);
    }

    return signatures;
  }

  // --------------------------------------------------------------------------
  // Streaming
  // --------------------------------------------------------------------------

  /**
   * Subscribe to real-time price updates
   */
  async subscribePrices(
    feedIds: string[],
    callback: (prices: Map<string, PriceData>) => void,
    options?: { allowUnordered?: boolean }
  ): Promise<{ close: () => void }> {
    const eventSource = await this.hermesClient.getPriceUpdatesStream(feedIds, {
      parsed: true,
      allowUnordered: options?.allowUnordered ?? false,
    });

    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        const priceMap = new Map<string, PriceData>();
        const now = Math.floor(Date.now() / 1000);

        for (const update of data.parsed || []) {
          const { price, conf, expo, publish_time } = update.price;
          const priceNum = Number(price) * Math.pow(10, expo);
          const confNum = Number(conf) * Math.pow(10, expo);

          priceMap.set("0x" + update.id, {
            feedId: "0x" + update.id,
            price: priceNum,
            confidence: confNum,
            confidencePercent: (confNum / Math.abs(priceNum)) * 100,
            publishTime: new Date(publish_time * 1000),
            age: now - publish_time,
          });
        }

        callback(priceMap);
      } catch (error) {
        console.error("Error processing price update:", error);
      }
    };

    return {
      close: () => eventSource.close(),
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert price to USD string
 */
export function formatUSD(price: number): string {
  if (Math.abs(price) >= 1) {
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  return `$${price.toFixed(8)}`;
}

/**
 * Get safe price bounds
 */
export function getSafeBounds(
  price: number,
  confidence: number,
  sigmas: number = 1
): { lower: number; mid: number; upper: number } {
  const halfWidth = confidence * sigmas;
  return {
    lower: price - halfWidth,
    mid: price,
    upper: price + halfWidth,
  };
}

/**
 * Calculate token value in USD
 */
export function calculateUSDValue(
  tokenAmount: number,
  tokenDecimals: number,
  price: number
): number {
  const amount = tokenAmount / Math.pow(10, tokenDecimals);
  return amount * price;
}

/**
 * Calculate tokens for USD amount
 */
export function calculateTokensForUSD(
  usdAmount: number,
  tokenDecimals: number,
  price: number
): number {
  const tokens = usdAmount / price;
  return tokens * Math.pow(10, tokenDecimals);
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=== Pyth Client Template ===\n");

  // Create client
  const client = new PythClient();

  // Fetch single price
  console.log("Fetching SOL/USD price...");
  const solPrice = await client.getPrice(PRICE_FEEDS.SOL_USD);
  console.log(`SOL/USD: ${formatUSD(solPrice.price)}`);
  console.log(`Confidence: ±${formatUSD(solPrice.confidence)} (${solPrice.confidencePercent.toFixed(3)}%)`);
  console.log(`Age: ${solPrice.age}s\n`);

  // Fetch multiple prices
  console.log("Fetching multiple prices...");
  const prices = await client.getPrices([
    PRICE_FEEDS.BTC_USD,
    PRICE_FEEDS.ETH_USD,
    PRICE_FEEDS.SOL_USD,
  ]);

  for (const [feedId, price] of prices) {
    const symbol = Object.entries(PRICE_FEEDS).find(
      ([_, id]) => id === feedId
    )?.[0] || feedId;
    console.log(`${symbol}: ${formatUSD(price.price)}`);
  }

  // Validated price
  console.log("\nFetching validated price...");
  try {
    const validatedPrice = await client.getValidatedPrice(PRICE_FEEDS.BTC_USD, {
      maxAgeSecs: 30,
      maxConfidenceBps: 100,
    });
    console.log(`BTC/USD (validated): ${formatUSD(validatedPrice.price)}`);
  } catch (error) {
    console.log(`Validation failed: ${error}`);
  }

  // Safe bounds example
  console.log("\nSafe price bounds (2-sigma):");
  const bounds = getSafeBounds(solPrice.price, solPrice.confidence, 2);
  console.log(`SOL/USD: ${formatUSD(bounds.lower)} - ${formatUSD(bounds.upper)}`);

  // Value calculation
  console.log("\nValue calculation:");
  const solAmount = 10 * 1e9; // 10 SOL in lamports
  const usdValue = calculateUSDValue(solAmount, 9, solPrice.price);
  console.log(`10 SOL = ${formatUSD(usdValue)}`);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
