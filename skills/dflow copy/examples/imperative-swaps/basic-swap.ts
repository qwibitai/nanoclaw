/**
 * DFlow Imperative Swap Example
 *
 * Demonstrates a complete imperative swap flow:
 * 1. Get quote with exact route
 * 2. Generate swap transaction
 * 3. Sign and submit
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// Configuration
const API_BASE = "https://quote-api.dflow.net";
const API_KEY = process.env.DFLOW_API_KEY;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Token addresses
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: Array<{
    venue: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
  }>;
}

interface SwapResponse {
  swapTransaction: string;
  computeUnitLimit: number;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

/**
 * Get headers with optional API key
 */
function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }
  return headers;
}

/**
 * Step 1: Get a quote for the swap
 */
async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = 50
): Promise<QuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: slippageBps.toString(),
  });

  const response = await fetch(`${API_BASE}/quote?${params}`, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Quote failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

/**
 * Step 2: Generate swap transaction from quote
 */
async function getSwapTransaction(
  quote: QuoteResponse,
  userPublicKey: string
): Promise<SwapResponse> {
  const response = await fetch(`${API_BASE}/swap`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      userPublicKey,
      quoteResponse: quote,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 150000,
      wrapAndUnwrapSol: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Swap failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

/**
 * Step 3: Sign and submit transaction
 */
async function signAndSubmit(
  connection: Connection,
  swapTransaction: string,
  keypair: Keypair
): Promise<string> {
  // Deserialize the transaction
  const transactionBuffer = Buffer.from(swapTransaction, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuffer);

  // Sign with user's keypair
  transaction.sign([keypair]);

  // Send and confirm
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  return signature;
}

/**
 * Main swap function
 */
async function imperativeSwap(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amountIn: string,
  slippageBps: number = 50
): Promise<{ signature: string; outAmount: string }> {
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("Step 1: Getting quote...");
  const quote = await getQuote(inputMint, outputMint, amountIn, slippageBps);

  console.log(`  Input: ${quote.inAmount} (${inputMint.slice(0, 8)}...)`);
  console.log(`  Output: ${quote.outAmount} (${outputMint.slice(0, 8)}...)`);
  console.log(`  Min Output: ${quote.minOutAmount}`);
  console.log(`  Price Impact: ${quote.priceImpactPct}%`);
  console.log(`  Route: ${quote.routePlan.map(r => r.venue).join(" → ")}`);

  console.log("\nStep 2: Generating swap transaction...");
  const swapResponse = await getSwapTransaction(
    quote,
    keypair.publicKey.toBase58()
  );

  console.log(`  Compute Units: ${swapResponse.computeUnitLimit}`);
  console.log(`  Priority Fee: ${swapResponse.prioritizationFeeLamports} lamports`);

  console.log("\nStep 3: Signing and submitting...");
  const signature = await signAndSubmit(
    connection,
    swapResponse.swapTransaction,
    keypair
  );

  console.log(`  Signature: ${signature}`);
  console.log(`  Explorer: https://solscan.io/tx/${signature}`);

  return {
    signature,
    outAmount: quote.outAmount,
  };
}

/**
 * Example usage
 */
async function main() {
  // Load keypair from environment
  const secretKey = process.env.SOLANA_PRIVATE_KEY;
  if (!secretKey) {
    throw new Error("SOLANA_PRIVATE_KEY not set");
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Swap 0.1 SOL to USDC
  const result = await imperativeSwap(
    keypair,
    TOKENS.SOL,
    TOKENS.USDC,
    "100000000", // 0.1 SOL (9 decimals)
    50 // 0.5% slippage
  );

  console.log("\n✓ Swap completed!");
  console.log(`  Received: ${parseInt(result.outAmount) / 1e6} USDC`);
}

// Run if executed directly
main().catch(console.error);
