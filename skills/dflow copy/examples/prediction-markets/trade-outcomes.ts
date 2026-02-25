/**
 * DFlow Prediction Market - Trade Outcomes Example
 *
 * Demonstrates how to trade prediction market outcome tokens:
 * - Initialize prediction market positions
 * - Buy YES/NO outcome tokens
 * - Sell outcome tokens back to USDC
 * - Monitor async order execution
 * - Handle order status and fills
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// API Configuration
const SWAP_API = "https://quote-api.dflow.net";
const METADATA_API = "https://api.prod.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY || "";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Common token mints
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Types
interface Market {
  ticker: string;
  yes_mint: string;
  no_mint: string;
  yes_price: number;
  no_price: number;
}

interface OrderResponse {
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  executionMode: "sync" | "async";
  transaction: string;
  computeUnitLimit: number;
  lastValidBlockHeight: number;
  routePlan: Array<{
    venue: string;
    inAmount: string;
    outAmount: string;
  }>;
}

interface OrderStatus {
  status: "pending" | "open" | "pendingClose" | "closed" | "expired" | "failed";
  inAmount?: string;
  outAmount?: string;
  fills?: Array<{
    signature: string;
    inAmount: string;
    outAmount: string;
    timestamp: number;
  }>;
}

// Helper function for swap API requests
async function swapApiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  const response = await fetch(`${SWAP_API}${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Swap API Error ${response.status}: ${error}`);
  }

  return response.json();
}

// Helper function for metadata API requests
async function metadataApiRequest<T>(endpoint: string): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }

  const response = await fetch(`${METADATA_API}${endpoint}`, { headers });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Metadata API Error ${response.status}: ${error}`);
  }

  return response.json();
}

// ============================================
// Market Functions
// ============================================

/**
 * Get market details by ticker
 */
async function getMarket(ticker: string): Promise<Market> {
  return metadataApiRequest<Market>(`/api/v1/market/${ticker}`);
}

/**
 * Initialize prediction market token for trading
 * Required before first trade with a prediction market token
 */
async function initializePredictionMarket(
  marketMint: string,
  userPublicKey: string
): Promise<{ transaction: string }> {
  const params = new URLSearchParams({
    marketMint,
    userPublicKey,
  });

  return swapApiRequest(`/prediction-market-init?${params}`);
}

// ============================================
// Trading Functions
// ============================================

/**
 * Get order quote and transaction for trading outcome tokens
 */
async function getOrder(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps?: string;
  predictionMarketSlippageBps?: string;
}): Promise<OrderResponse> {
  const searchParams = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    userPublicKey: params.userPublicKey,
    slippageBps: params.slippageBps || "100",
    predictionMarketSlippageBps: params.predictionMarketSlippageBps || "200",
  });

  return swapApiRequest<OrderResponse>(`/order?${searchParams}`);
}

/**
 * Check order status for async orders
 */
async function getOrderStatus(
  signature: string,
  lastValidBlockHeight?: number
): Promise<OrderStatus> {
  const params = new URLSearchParams({ signature });
  if (lastValidBlockHeight) {
    params.set("lastValidBlockHeight", lastValidBlockHeight.toString());
  }

  return swapApiRequest<OrderStatus>(`/order-status?${params}`);
}

/**
 * Monitor async order until completion
 */
async function monitorOrder(
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs: number = 60000
): Promise<OrderStatus> {
  const startTime = Date.now();
  const pendingStatuses = ["pending", "open", "pendingClose"];

  while (Date.now() - startTime < timeoutMs) {
    const status = await getOrderStatus(signature, lastValidBlockHeight);

    console.log(`  Order status: ${status.status}`);

    if (!pendingStatuses.includes(status.status)) {
      return status;
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("Order monitoring timeout");
}

/**
 * Sign and send transaction
 */
async function signAndSendTransaction(
  connection: Connection,
  keypair: Keypair,
  transactionBase64: string
): Promise<string> {
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(transactionBase64, "base64")
  );

  transaction.sign([keypair]);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  return signature;
}

// ============================================
// Trade Execution
// ============================================

/**
 * Buy YES tokens for a prediction market
 */
async function buyYesTokens(
  connection: Connection,
  keypair: Keypair,
  market: Market,
  usdcAmount: string // Amount in USDC (scaled, e.g., "10000000" for 10 USDC)
): Promise<{ signature: string; outAmount: string }> {
  console.log(`\nBuying YES tokens for ${market.ticker}...`);
  console.log(`  Input: ${Number(usdcAmount) / 1e6} USDC`);
  console.log(`  Current YES price: ${market.yes_price}`);

  // Get order
  const order = await getOrder({
    inputMint: USDC,
    outputMint: market.yes_mint,
    amount: usdcAmount,
    userPublicKey: keypair.publicKey.toBase58(),
    slippageBps: "100",
    predictionMarketSlippageBps: "200",
  });

  console.log(`  Expected output: ${Number(order.outAmount) / 1e6} YES tokens`);
  console.log(`  Min output: ${Number(order.minOutAmount) / 1e6} YES tokens`);
  console.log(`  Price impact: ${order.priceImpactPct}%`);
  console.log(`  Execution mode: ${order.executionMode}`);

  // Sign and send
  const signature = await signAndSendTransaction(
    connection,
    keypair,
    order.transaction
  );
  console.log(`  Transaction sent: ${signature}`);

  // Handle based on execution mode
  if (order.executionMode === "async") {
    console.log("  Monitoring async order...");
    const finalStatus = await monitorOrder(
      signature,
      order.lastValidBlockHeight
    );

    if (finalStatus.status !== "closed") {
      throw new Error(`Order failed with status: ${finalStatus.status}`);
    }

    return {
      signature,
      outAmount: finalStatus.outAmount || order.outAmount,
    };
  } else {
    // Sync execution - confirm transaction
    await connection.confirmTransaction(signature, "confirmed");
    return { signature, outAmount: order.outAmount };
  }
}

/**
 * Buy NO tokens for a prediction market
 */
async function buyNoTokens(
  connection: Connection,
  keypair: Keypair,
  market: Market,
  usdcAmount: string
): Promise<{ signature: string; outAmount: string }> {
  console.log(`\nBuying NO tokens for ${market.ticker}...`);
  console.log(`  Input: ${Number(usdcAmount) / 1e6} USDC`);
  console.log(`  Current NO price: ${market.no_price}`);

  const order = await getOrder({
    inputMint: USDC,
    outputMint: market.no_mint,
    amount: usdcAmount,
    userPublicKey: keypair.publicKey.toBase58(),
  });

  console.log(`  Expected output: ${Number(order.outAmount) / 1e6} NO tokens`);
  console.log(`  Execution mode: ${order.executionMode}`);

  const signature = await signAndSendTransaction(
    connection,
    keypair,
    order.transaction
  );
  console.log(`  Transaction sent: ${signature}`);

  if (order.executionMode === "async") {
    const finalStatus = await monitorOrder(
      signature,
      order.lastValidBlockHeight
    );
    if (finalStatus.status !== "closed") {
      throw new Error(`Order failed: ${finalStatus.status}`);
    }
    return { signature, outAmount: finalStatus.outAmount || order.outAmount };
  } else {
    await connection.confirmTransaction(signature, "confirmed");
    return { signature, outAmount: order.outAmount };
  }
}

/**
 * Sell outcome tokens back to USDC
 */
async function sellOutcomeTokens(
  connection: Connection,
  keypair: Keypair,
  outcomeMint: string,
  amount: string,
  outcomeType: "yes" | "no"
): Promise<{ signature: string; outAmount: string }> {
  console.log(`\nSelling ${outcomeType.toUpperCase()} tokens...`);
  console.log(`  Input: ${Number(amount) / 1e6} ${outcomeType.toUpperCase()} tokens`);

  const order = await getOrder({
    inputMint: outcomeMint,
    outputMint: USDC,
    amount,
    userPublicKey: keypair.publicKey.toBase58(),
  });

  console.log(`  Expected output: ${Number(order.outAmount) / 1e6} USDC`);
  console.log(`  Execution mode: ${order.executionMode}`);

  const signature = await signAndSendTransaction(
    connection,
    keypair,
    order.transaction
  );
  console.log(`  Transaction sent: ${signature}`);

  if (order.executionMode === "async") {
    const finalStatus = await monitorOrder(
      signature,
      order.lastValidBlockHeight
    );
    if (finalStatus.status !== "closed") {
      throw new Error(`Order failed: ${finalStatus.status}`);
    }
    return { signature, outAmount: finalStatus.outAmount || order.outAmount };
  } else {
    await connection.confirmTransaction(signature, "confirmed");
    return { signature, outAmount: order.outAmount };
  }
}

// ============================================
// Advanced Trading
// ============================================

/**
 * Execute a market neutral position (buy both YES and NO)
 */
async function executeMarketNeutral(
  connection: Connection,
  keypair: Keypair,
  market: Market,
  usdcAmount: string
): Promise<{
  yesSignature: string;
  noSignature: string;
  yesTokens: string;
  noTokens: string;
}> {
  console.log(`\nExecuting market neutral position for ${market.ticker}...`);

  // Split USDC between YES and NO based on current prices
  const totalUsdc = Number(usdcAmount);
  const yesAllocation = Math.floor(totalUsdc * market.no_price); // Inverse weighting
  const noAllocation = totalUsdc - yesAllocation;

  console.log(`  YES allocation: ${yesAllocation / 1e6} USDC`);
  console.log(`  NO allocation: ${noAllocation / 1e6} USDC`);

  // Execute both trades
  const yesResult = await buyYesTokens(
    connection,
    keypair,
    market,
    yesAllocation.toString()
  );

  const noResult = await buyNoTokens(
    connection,
    keypair,
    market,
    noAllocation.toString()
  );

  return {
    yesSignature: yesResult.signature,
    noSignature: noResult.signature,
    yesTokens: yesResult.outAmount,
    noTokens: noResult.outAmount,
  };
}

/**
 * Get quote only (without transaction) for price checking
 */
async function getQuoteOnly(
  inputMint: string,
  outputMint: string,
  amount: string
): Promise<{
  outAmount: string;
  priceImpact: string;
  effectivePrice: number;
}> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: "100",
  });

  const quote = await swapApiRequest<OrderResponse>(`/order?${params}`);

  const inAmountNum = Number(amount) / 1e6;
  const outAmountNum = Number(quote.outAmount) / 1e6;
  const effectivePrice = outAmountNum / inAmountNum;

  return {
    outAmount: quote.outAmount,
    priceImpact: quote.priceImpactPct,
    effectivePrice,
  };
}

// ============================================
// Example Usage
// ============================================

async function main() {
  console.log("DFlow Prediction Market - Trade Outcomes Example\n");
  console.log("=".repeat(50));

  // Setup connection
  const connection = new Connection(RPC_URL, "confirmed");

  // Load keypair from environment (base58 encoded private key)
  const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyString) {
    console.log("\nNote: Set SOLANA_PRIVATE_KEY to execute actual trades.");
    console.log("Running in quote-only mode...\n");

    // Demo: Get quotes for a sample market
    try {
      const market = await getMarket("SAMPLE-MARKET");
      console.log(`Market: ${market.ticker}`);
      console.log(`YES mint: ${market.yes_mint}`);
      console.log(`NO mint: ${market.no_mint}`);
      console.log(`Current prices - YES: ${market.yes_price}, NO: ${market.no_price}`);

      // Get quote for buying YES
      console.log("\nGetting quote for 10 USDC -> YES tokens...");
      const yesQuote = await getQuoteOnly(USDC, market.yes_mint, "10000000");
      console.log(`  Output: ${Number(yesQuote.outAmount) / 1e6} YES tokens`);
      console.log(`  Price impact: ${yesQuote.priceImpact}%`);
      console.log(`  Effective price: ${yesQuote.effectivePrice.toFixed(4)} YES/USDC`);

      // Get quote for buying NO
      console.log("\nGetting quote for 10 USDC -> NO tokens...");
      const noQuote = await getQuoteOnly(USDC, market.no_mint, "10000000");
      console.log(`  Output: ${Number(noQuote.outAmount) / 1e6} NO tokens`);
      console.log(`  Price impact: ${noQuote.priceImpact}%`);
      console.log(`  Effective price: ${noQuote.effectivePrice.toFixed(4)} NO/USDC`);
    } catch (error) {
      console.log("Could not fetch market data. Using mock examples.");
    }

    return;
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyString));
  console.log(`\nWallet: ${keypair.publicKey.toBase58()}`);

  try {
    // 1. Get market details
    const marketTicker = process.env.MARKET_TICKER || "SAMPLE-MARKET";
    console.log(`\n1. Fetching market: ${marketTicker}`);
    const market = await getMarket(marketTicker);
    console.log(`  YES price: ${market.yes_price}`);
    console.log(`  NO price: ${market.no_price}`);
    console.log(`  YES mint: ${market.yes_mint}`);
    console.log(`  NO mint: ${market.no_mint}`);

    // 2. Buy YES tokens (10 USDC worth)
    console.log("\n2. Buying YES tokens...");
    const buyResult = await buyYesTokens(
      connection,
      keypair,
      market,
      "10000000" // 10 USDC
    );
    console.log(`  Success! Received ${Number(buyResult.outAmount) / 1e6} YES tokens`);
    console.log(`  Signature: ${buyResult.signature}`);

    // 3. Sell some YES tokens back
    console.log("\n3. Selling half of YES tokens...");
    const sellAmount = (Number(buyResult.outAmount) / 2).toString();
    const sellResult = await sellOutcomeTokens(
      connection,
      keypair,
      market.yes_mint,
      sellAmount,
      "yes"
    );
    console.log(`  Success! Received ${Number(sellResult.outAmount) / 1e6} USDC`);
    console.log(`  Signature: ${sellResult.signature}`);

    console.log("\n" + "=".repeat(50));
    console.log("Trading examples completed successfully!");
  } catch (error) {
    console.error("\nError:", error instanceof Error ? error.message : error);
  }
}

// Run examples
main();

// Export functions for use in other modules
export {
  getMarket,
  initializePredictionMarket,
  getOrder,
  getOrderStatus,
  monitorOrder,
  buyYesTokens,
  buyNoTokens,
  sellOutcomeTokens,
  executeMarketNeutral,
  getQuoteOnly,
};
