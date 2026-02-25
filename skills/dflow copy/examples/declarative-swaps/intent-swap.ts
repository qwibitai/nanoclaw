/**
 * DFlow Declarative Swap Example
 *
 * Demonstrates intent-based swaps with deferred route optimization:
 * 1. Get intent quote (guaranteed minimum)
 * 2. Sign the intent transaction
 * 3. Submit intent for execution
 * 4. Monitor order status
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

// Token addresses
const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

interface IntentResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  guaranteedOutAmount: string;
  estimatedOutAmount: string;
  slippageBps: number;
  transaction: string;
  lastValidBlockHeight: number;
}

interface SubmitResponse {
  orderId: string;
  status: string;
  openSignature: string;
}

interface OrderStatus {
  status: "pending" | "open" | "pendingClose" | "closed" | "failed" | "expired";
  inAmount?: string;
  outAmount?: string;
  fills?: Array<{
    signature: string;
    inAmount: string;
    outAmount: string;
  }>;
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
 * Step 1: Get intent quote
 *
 * Intent quotes provide:
 * - Guaranteed minimum output
 * - Estimated output (may be higher)
 * - Unsigned transaction to sign
 */
async function getIntentQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  userPublicKey: string,
  slippageBps: number = 100
): Promise<IntentResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    userPublicKey,
    slippageBps: slippageBps.toString(),
  });

  const response = await fetch(`${API_BASE}/intent?${params}`, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Intent quote failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Step 2: Sign the intent transaction
 */
function signIntent(
  intentResponse: IntentResponse,
  keypair: Keypair
): string {
  const transactionBuffer = Buffer.from(intentResponse.transaction, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuffer);

  transaction.sign([keypair]);

  return Buffer.from(transaction.serialize()).toString("base64");
}

/**
 * Step 3: Submit signed intent
 */
async function submitIntent(
  signedTransaction: string,
  intentResponse: IntentResponse
): Promise<SubmitResponse> {
  const response = await fetch(`${API_BASE}/submit-intent`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      signedTransaction,
      intentResponse,
    }),
  });

  if (!response.ok) {
    throw new Error(`Submit intent failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Step 4: Monitor order status
 */
async function monitorOrder(
  signature: string,
  timeoutMs: number = 60000
): Promise<OrderStatus> {
  const startTime = Date.now();
  const terminalStatuses = ["closed", "failed", "expired"];

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(
      `${API_BASE}/order-status?signature=${signature}`,
      { headers: getHeaders() }
    );

    if (response.status === 404) {
      // Order not indexed yet
      await sleep(2000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Status check failed: ${response.status}`);
    }

    const status: OrderStatus = await response.json();

    console.log(`  Status: ${status.status}`);

    if (terminalStatuses.includes(status.status)) {
      return status;
    }

    await sleep(2000);
  }

  throw new Error("Order monitoring timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main declarative swap function
 */
async function declarativeSwap(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amountIn: string,
  slippageBps: number = 100
): Promise<{ signature: string; status: OrderStatus }> {
  console.log("Step 1: Getting intent quote...");
  const intent = await getIntentQuote(
    inputMint,
    outputMint,
    amountIn,
    keypair.publicKey.toBase58(),
    slippageBps
  );

  console.log(`  Input: ${intent.inAmount}`);
  console.log(`  Guaranteed Output: ${intent.guaranteedOutAmount}`);
  console.log(`  Estimated Output: ${intent.estimatedOutAmount}`);
  console.log(`  Slippage: ${intent.slippageBps} bps`);

  console.log("\nStep 2: Signing intent...");
  const signedTransaction = signIntent(intent, keypair);
  console.log("  ✓ Intent signed");

  console.log("\nStep 3: Submitting intent...");
  const submission = await submitIntent(signedTransaction, intent);
  console.log(`  Order ID: ${submission.orderId}`);
  console.log(`  Open Signature: ${submission.openSignature}`);

  console.log("\nStep 4: Monitoring order...");
  const finalStatus = await monitorOrder(submission.openSignature);

  if (finalStatus.status === "closed") {
    console.log("\n✓ Swap completed!");
    console.log(`  Final Output: ${finalStatus.outAmount}`);
    if (finalStatus.fills?.length) {
      console.log(`  Fills: ${finalStatus.fills.length}`);
    }
  } else {
    console.log(`\n✗ Swap ${finalStatus.status}`);
  }

  return {
    signature: submission.openSignature,
    status: finalStatus,
  };
}

/**
 * Example: Compare declarative vs estimated
 */
async function compareExecution(
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amount: string
) {
  // Get intent to see guaranteed vs estimated
  const intent = await getIntentQuote(
    inputMint,
    outputMint,
    amount,
    keypair.publicKey.toBase58()
  );

  const guaranteed = BigInt(intent.guaranteedOutAmount);
  const estimated = BigInt(intent.estimatedOutAmount);
  const improvement = Number(estimated - guaranteed) / Number(guaranteed) * 100;

  console.log("Declarative Swap Analysis:");
  console.log(`  Guaranteed: ${guaranteed}`);
  console.log(`  Estimated: ${estimated}`);
  console.log(`  Potential Improvement: ${improvement.toFixed(2)}%`);
  console.log("\n  Benefits:");
  console.log("  - Route optimized at execution time");
  console.log("  - Enhanced sandwich protection");
  console.log("  - Lower latency execution");
}

/**
 * Example usage
 */
async function main() {
  const secretKey = process.env.SOLANA_PRIVATE_KEY;
  if (!secretKey) {
    throw new Error("SOLANA_PRIVATE_KEY not set");
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}\n`);

  // Compare execution modes
  await compareExecution(
    keypair,
    TOKENS.SOL,
    TOKENS.USDC,
    "100000000" // 0.1 SOL
  );

  console.log("\n" + "=".repeat(50) + "\n");

  // Execute declarative swap
  const result = await declarativeSwap(
    keypair,
    TOKENS.SOL,
    TOKENS.USDC,
    "100000000", // 0.1 SOL
    100 // 1% slippage
  );

  console.log(`\nExplorer: https://solscan.io/tx/${result.signature}`);
}

main().catch(console.error);
