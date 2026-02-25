/**
 * DFlow Swap Client Template
 *
 * Copy this file as a starting point for integrating DFlow swaps.
 * Includes both imperative and declarative swap support.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

// ============================================================================
// Configuration
// ============================================================================

const DFLOW_API_BASE = "https://quote-api.dflow.net";

export interface DFlowConfig {
  apiKey?: string;
  rpcUrl: string;
  defaultSlippageBps?: number;
  defaultPriorityFee?: "auto" | "medium" | "high" | number;
}

// ============================================================================
// Types
// ============================================================================

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  onlyDirectRoutes?: boolean;
  excludeDexes?: string[];
}

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: RouteLeg[];
}

export interface RouteLeg {
  venue: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
}

export interface SwapParams {
  userPublicKey: string;
  quoteResponse: QuoteResponse;
  prioritizationFeeLamports?: "auto" | number;
  dynamicComputeUnitLimit?: boolean;
  wrapAndUnwrapSol?: boolean;
}

export interface SwapResponse {
  swapTransaction: string;
  computeUnitLimit: number;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export interface OrderResponse {
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  executionMode: "sync" | "async";
  transaction: string;
  routePlan: RouteLeg[];
}

export interface OrderStatus {
  status: "pending" | "open" | "pendingClose" | "closed" | "failed" | "expired";
  inAmount?: string;
  outAmount?: string;
}

export interface SwapResult {
  success: boolean;
  signature: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
  route: string[];
}

// ============================================================================
// DFlow Client
// ============================================================================

export class DFlowClient {
  private config: DFlowConfig;
  private connection: Connection;

  constructor(config: DFlowConfig) {
    this.config = {
      defaultSlippageBps: 50,
      defaultPriorityFee: "auto",
      ...config,
    };
    this.connection = new Connection(config.rpcUrl, "confirmed");
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    return headers;
  }

  // --------------------------------------------------------------------------
  // Quote Methods
  // --------------------------------------------------------------------------

  /**
   * Get a quote for an imperative swap
   */
  async getQuote(params: QuoteParams): Promise<QuoteResponse> {
    const queryParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: (params.slippageBps ?? this.config.defaultSlippageBps!).toString(),
    });

    if (params.onlyDirectRoutes) {
      queryParams.append("onlyDirectRoutes", "true");
    }

    if (params.excludeDexes?.length) {
      queryParams.append("excludeDexes", params.excludeDexes.join(","));
    }

    const response = await fetch(`${DFLOW_API_BASE}/quote?${queryParams}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Quote failed: ${response.status}`);
    }

    return response.json();
  }

  // --------------------------------------------------------------------------
  // Swap Methods
  // --------------------------------------------------------------------------

  /**
   * Get swap transaction from quote
   */
  async getSwapTransaction(params: SwapParams): Promise<SwapResponse> {
    const response = await fetch(`${DFLOW_API_BASE}/swap`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        ...params,
        dynamicComputeUnitLimit: params.dynamicComputeUnitLimit ?? true,
        prioritizationFeeLamports:
          params.prioritizationFeeLamports ?? this.config.defaultPriorityFee,
        wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Swap transaction failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Execute an imperative swap
   */
  async executeImperativeSwap(
    keypair: Keypair,
    params: QuoteParams
  ): Promise<SwapResult> {
    // Get quote
    const quote = await this.getQuote(params);

    // Get swap transaction
    const swap = await this.getSwapTransaction({
      userPublicKey: keypair.publicKey.toBase58(),
      quoteResponse: quote,
    });

    // Sign and send
    const signature = await this.signAndSend(swap.swapTransaction, keypair);

    return {
      success: true,
      signature,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
      route: quote.routePlan.map(r => r.venue),
    };
  }

  // --------------------------------------------------------------------------
  // Trade API Methods (Recommended)
  // --------------------------------------------------------------------------

  /**
   * Get order (quote + transaction in one call)
   */
  async getOrder(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    userPublicKey: string;
    slippageBps?: number;
  }): Promise<OrderResponse> {
    const queryParams = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      userPublicKey: params.userPublicKey,
      slippageBps: (params.slippageBps ?? this.config.defaultSlippageBps!).toString(),
    });

    const response = await fetch(`${DFLOW_API_BASE}/order?${queryParams}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Order failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get order status
   */
  async getOrderStatus(signature: string): Promise<OrderStatus> {
    const response = await fetch(
      `${DFLOW_API_BASE}/order-status?signature=${signature}`,
      { headers: this.getHeaders() }
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
   * Execute a trade using the unified Trade API
   */
  async executeTrade(
    keypair: Keypair,
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps?: number
  ): Promise<SwapResult> {
    // Get order
    const order = await this.getOrder({
      inputMint,
      outputMint,
      amount,
      userPublicKey: keypair.publicKey.toBase58(),
      slippageBps,
    });

    // Sign and send
    const signature = await this.signAndSend(order.transaction, keypair);

    // Handle execution mode
    let finalOutput = order.outAmount;

    if (order.executionMode === "async") {
      const status = await this.waitForOrder(signature);
      if (status.status !== "closed") {
        throw new Error(`Order ${status.status}`);
      }
      finalOutput = status.outAmount || order.outAmount;
    } else {
      await this.confirmTransaction(signature);
    }

    return {
      success: true,
      signature,
      inputAmount: amount,
      outputAmount: finalOutput,
      priceImpact: order.priceImpactPct,
      route: order.routePlan.map(r => r.venue),
    };
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Sign and send a base64-encoded transaction
   */
  private async signAndSend(
    base64Transaction: string,
    keypair: Keypair
  ): Promise<string> {
    const txBuffer = Buffer.from(base64Transaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);

    transaction.sign([keypair]);

    return this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  /**
   * Wait for transaction confirmation
   */
  private async confirmTransaction(signature: string): Promise<void> {
    const latestBlockhash = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
  }

  /**
   * Wait for async order completion
   */
  private async waitForOrder(
    signature: string,
    timeoutMs: number = 60000
  ): Promise<OrderStatus> {
    const start = Date.now();
    const terminalStatuses = ["closed", "failed", "expired"];

    while (Date.now() - start < timeoutMs) {
      const status = await this.getOrderStatus(signature);

      if (terminalStatuses.includes(status.status)) {
        return status;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error("Order timed out");
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get supported tokens
   */
  async getTokens(): Promise<string[]> {
    const response = await fetch(`${DFLOW_API_BASE}/tokens`, {
      headers: this.getHeaders(),
    });
    const data = await response.json();
    return data.tokens;
  }

  /**
   * Get supported venues
   */
  async getVenues(): Promise<Array<{ name: string; id: string }>> {
    const response = await fetch(`${DFLOW_API_BASE}/venues`, {
      headers: this.getHeaders(),
    });
    const data = await response.json();
    return data.venues;
  }
}

// ============================================================================
// Usage Example
// ============================================================================

/*
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const client = new DFlowClient({
  apiKey: process.env.DFLOW_API_KEY,
  rpcUrl: "https://api.mainnet-beta.solana.com",
  defaultSlippageBps: 50,
});

const keypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

// Simple trade
const result = await client.executeTrade(
  keypair,
  "So11111111111111111111111111111111111111112", // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "1000000000", // 1 SOL
  50 // 0.5% slippage
);

console.log(`Swapped! Output: ${result.outputAmount}`);
console.log(`https://solscan.io/tx/${result.signature}`);
*/
