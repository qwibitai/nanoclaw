/**
 * DFlow Trade API Example (Unified Interface)
 *
 * The Trade API is the recommended way to trade on DFlow.
 * It automatically handles both sync and async execution modes.
 *
 * Benefits:
 * - Single endpoint for quote + transaction
 * - Automatic execution mode selection
 * - Works for both spot and prediction markets
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// Configuration
const API_BASE = "https://quote-api.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Common tokens
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
};

interface OrderResponse {
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  executionMode: "sync" | "async";
  transaction: string;
  computeUnitLimit: number;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  routePlan: Array<{
    venue: string;
    inAmount: string;
    outAmount: string;
  }>;
}

interface OrderStatus {
  status: "pending" | "open" | "pendingClose" | "closed" | "failed" | "expired";
  inAmount?: string;
  outAmount?: string;
  fills?: Array<{ signature: string; inAmount: string; outAmount: string }>;
}

interface TradeResult {
  success: boolean;
  signature: string;
  inputAmount: string;
  outputAmount: string;
  executionMode: "sync" | "async";
  route: string[];
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  return headers;
}

/**
 * Get order (quote + transaction in one call)
 */
async function getOrder(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps?: number;
  prioritizationFeeLamports?: string | number;
}): Promise<OrderResponse> {
  const queryParams = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    userPublicKey: params.userPublicKey,
    slippageBps: (params.slippageBps ?? 50).toString(),
  });

  if (params.prioritizationFeeLamports) {
    queryParams.append(
      "prioritizationFeeLamports",
      params.prioritizationFeeLamports.toString()
    );
  }

  const response = await fetch(`${API_BASE}/order?${queryParams}`, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Order request failed: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Check order status (for async orders)
 */
async function getOrderStatus(signature: string): Promise<OrderStatus> {
  const response = await fetch(
    `${API_BASE}/order-status?signature=${signature}`,
    { headers: getHeaders() }
  );

  if (response.status === 404) {
    return { status: "pending" };
  }

  if (!response.ok) {
    throw new Error(`Status check failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Monitor async order until completion
 */
async function monitorAsyncOrder(
  signature: string,
  timeoutMs: number = 60000
): Promise<OrderStatus> {
  const start = Date.now();
  const terminalStatuses = ["closed", "failed", "expired"];

  while (Date.now() - start < timeoutMs) {
    const status = await getOrderStatus(signature);

    if (terminalStatuses.includes(status.status)) {
      return status;
    }

    // Log progress
    if (status.status !== "pending") {
      console.log(`  Order status: ${status.status}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error("Order monitoring timed out");
}

/**
 * Execute a trade using the unified Trade API
 */
async function trade(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 50
): Promise<TradeResult> {
  console.log("Getting order...");

  // Step 1: Get order (quote + transaction)
  const order = await getOrder({
    inputMint,
    outputMint,
    amount,
    userPublicKey: keypair.publicKey.toBase58(),
    slippageBps,
    prioritizationFeeLamports: "auto",
  });

  console.log(`  Expected output: ${order.outAmount}`);
  console.log(`  Min output: ${order.minOutAmount}`);
  console.log(`  Price impact: ${order.priceImpactPct}%`);
  console.log(`  Execution mode: ${order.executionMode}`);
  console.log(`  Route: ${order.routePlan.map(r => r.venue).join(" → ")}`);

  // Step 2: Sign and send transaction
  console.log("\nSigning and submitting...");

  const txBuffer = Buffer.from(order.transaction, "base64");
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([keypair]);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log(`  Signature: ${signature}`);

  // Step 3: Handle based on execution mode
  let finalOutput = order.outAmount;

  if (order.executionMode === "sync") {
    // Sync trades complete atomically
    console.log("\nWaiting for confirmation (sync)...");

    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    console.log("  ✓ Transaction confirmed");
  } else {
    // Async trades need status monitoring
    console.log("\nMonitoring order (async)...");

    const finalStatus = await monitorAsyncOrder(signature);

    if (finalStatus.status === "closed") {
      finalOutput = finalStatus.outAmount || order.outAmount;
      console.log(`  ✓ Order closed - Output: ${finalOutput}`);
    } else {
      throw new Error(`Order ${finalStatus.status}`);
    }
  }

  return {
    success: true,
    signature,
    inputAmount: amount,
    outputAmount: finalOutput,
    executionMode: order.executionMode,
    route: order.routePlan.map(r => r.venue),
  };
}

/**
 * Batch multiple trades
 */
async function batchTrades(
  connection: Connection,
  keypair: Keypair,
  trades: Array<{
    inputMint: string;
    outputMint: string;
    amount: string;
  }>
): Promise<TradeResult[]> {
  const results: TradeResult[] = [];

  for (const t of trades) {
    try {
      console.log(`\nTrading ${t.amount} ${t.inputMint.slice(0, 8)}... → ${t.outputMint.slice(0, 8)}...`);
      const result = await trade(
        connection,
        keypair,
        t.inputMint,
        t.outputMint,
        t.amount
      );
      results.push(result);
    } catch (error) {
      console.error(`Trade failed: ${error}`);
      results.push({
        success: false,
        signature: "",
        inputAmount: t.amount,
        outputAmount: "0",
        executionMode: "sync",
        route: [],
      });
    }
  }

  return results;
}

/**
 * Example: Simple token swap
 */
async function exampleSimpleSwap() {
  const secretKey = process.env.SOLANA_PRIVATE_KEY;
  if (!secretKey) throw new Error("SOLANA_PRIVATE_KEY not set");

  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`Wallet: ${keypair.publicKey.toBase58()}\n`);
  console.log("=".repeat(50));
  console.log("Example: Swap 0.1 SOL to USDC");
  console.log("=".repeat(50) + "\n");

  const result = await trade(
    connection,
    keypair,
    TOKENS.SOL,
    TOKENS.USDC,
    "100000000", // 0.1 SOL
    50 // 0.5% slippage
  );

  console.log("\n" + "=".repeat(50));
  console.log("Trade Result:");
  console.log("=".repeat(50));
  console.log(`  Success: ${result.success}`);
  console.log(`  Input: ${parseInt(result.inputAmount) / 1e9} SOL`);
  console.log(`  Output: ${parseInt(result.outputAmount) / 1e6} USDC`);
  console.log(`  Mode: ${result.executionMode}`);
  console.log(`  Route: ${result.route.join(" → ")}`);
  console.log(`  Explorer: https://solscan.io/tx/${result.signature}`);
}

/**
 * Example: Multi-hop trade (SOL → USDC → BONK)
 */
async function exampleMultiHop() {
  const secretKey = process.env.SOLANA_PRIVATE_KEY;
  if (!secretKey) throw new Error("SOLANA_PRIVATE_KEY not set");

  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("\n" + "=".repeat(50));
  console.log("Example: Multi-hop SOL → USDC → BONK");
  console.log("=".repeat(50) + "\n");

  // First trade: SOL → USDC
  console.log("Trade 1: SOL → USDC");
  const trade1 = await trade(
    connection,
    keypair,
    TOKENS.SOL,
    TOKENS.USDC,
    "100000000" // 0.1 SOL
  );

  // Second trade: USDC → BONK
  console.log("\nTrade 2: USDC → BONK");
  const trade2 = await trade(
    connection,
    keypair,
    TOKENS.USDC,
    TOKENS.BONK,
    trade1.outputAmount // Use output from first trade
  );

  console.log("\n" + "=".repeat(50));
  console.log("Multi-hop Result:");
  console.log(`  Started with: 0.1 SOL`);
  console.log(`  Intermediate: ${parseInt(trade1.outputAmount) / 1e6} USDC`);
  console.log(`  Final: ${parseInt(trade2.outputAmount) / 1e5} BONK`);
}

// Run examples
async function main() {
  await exampleSimpleSwap();
  // await exampleMultiHop();  // Uncomment to run
}

main().catch(console.error);
