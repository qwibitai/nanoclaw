/**
 * Helius Setup Template
 *
 * A complete starter template for Helius integration with @solana/kit.
 *
 * Features:
 * - Helius SDK initialization
 * - RPC connection setup
 * - WebSocket subscriptions
 * - Transaction sending with priority fees
 * - DAS API usage
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Set HELIUS_API_KEY environment variable
 * 3. Import and use the functions
 */

import { createHelius } from "helius-sdk";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  prependTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  fetchEncodedAccount,
  type Rpc,
  type RpcSubscriptions,
  type KeyPairSigner,
  type Address,
  type IInstruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

// ============================================================================
// Configuration
// ============================================================================

const API_KEY = process.env.HELIUS_API_KEY!;

if (!API_KEY) {
  throw new Error("HELIUS_API_KEY environment variable is required");
}

// Network configuration
const NETWORK: "mainnet-beta" | "devnet" = "mainnet-beta";

const ENDPOINTS = {
  "mainnet-beta": {
    http: `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`,
    ws: `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`,
  },
  devnet: {
    http: `https://devnet.helius-rpc.com/?api-key=${API_KEY}`,
    ws: `wss://devnet.helius-rpc.com/?api-key=${API_KEY}`,
  },
};

// ============================================================================
// Initialize Clients
// ============================================================================

// Helius SDK client
export const helius = createHelius({
  apiKey: API_KEY,
  cluster: NETWORK,
});

// @solana/kit RPC clients
export const rpc: Rpc = createSolanaRpc(ENDPOINTS[NETWORK].http);
export const rpcSubscriptions: RpcSubscriptions = createSolanaRpcSubscriptions(
  ENDPOINTS[NETWORK].ws
);

// Constants
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

// ============================================================================
// Transaction Helpers
// ============================================================================

/**
 * Send a transaction with automatic priority fee estimation.
 */
export async function sendTransactionWithPriorityFee(
  signer: KeyPairSigner,
  instructions: IInstruction[],
  options: {
    priorityLevel?: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
    computeUnits?: number;
    skipPreflight?: boolean;
  } = {}
): Promise<string> {
  const {
    priorityLevel = "MEDIUM",
    computeUnits = 200_000,
    skipPreflight = false,
  } = options;

  // Get priority fee estimate
  const { priorityFeeEstimate } = await helius.getPriorityFeeEstimate({
    accountKeys: [signer.address],
    options: { priorityLevel },
  });

  // Get latest blockhash
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction
  let tx = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(signer.address, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    (tx) =>
      prependTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: computeUnits }),
          getSetComputeUnitPriceInstruction({
            microLamports: BigInt(priorityFeeEstimate),
          }),
        ],
        tx
      )
  );

  // Add instructions
  for (const ix of instructions) {
    tx = appendTransactionMessageInstruction(ix, tx);
  }

  // Sign and send
  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  await sendAndConfirm(signedTx, {
    commitment: "confirmed",
    skipPreflight,
  });

  return getSignatureFromTransaction(signedTx);
}

/**
 * Transfer SOL with priority fees.
 */
export async function transferSOL(
  sender: KeyPairSigner,
  recipient: string,
  amountSOL: number,
  priorityLevel: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH" = "MEDIUM"
): Promise<string> {
  const instruction = getTransferSolInstruction({
    source: sender,
    destination: address(recipient),
    amount: lamports(BigInt(Math.floor(amountSOL * 1e9))),
  });

  return sendTransactionWithPriorityFee(sender, [instruction], {
    priorityLevel,
    computeUnits: 100_000,
  });
}

// ============================================================================
// DAS API Helpers
// ============================================================================

/**
 * Get all NFTs owned by a wallet.
 */
export async function getNFTsForWallet(walletAddress: string) {
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    displayOptions: {
      showFungible: false,
      showCollectionMetadata: true,
    },
  });

  return response.items.filter(
    (asset) =>
      asset.interface !== "FungibleToken" &&
      asset.interface !== "FungibleAsset"
  );
}

/**
 * Get all fungible tokens owned by a wallet.
 */
export async function getTokensForWallet(walletAddress: string) {
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
    },
  });

  return {
    tokens: response.items.filter(
      (asset) =>
        asset.interface === "FungibleToken" ||
        asset.interface === "FungibleAsset"
    ),
    nativeBalance: response.nativeBalance,
  };
}

/**
 * Get complete portfolio for a wallet.
 */
export async function getWalletPortfolio(walletAddress: string) {
  const response = await helius.getAssetsByOwner({
    ownerAddress: walletAddress,
    displayOptions: {
      showFungible: true,
      showNativeBalance: true,
      showCollectionMetadata: true,
    },
  });

  const portfolio = {
    nfts: [] as typeof response.items,
    compressedNfts: [] as typeof response.items,
    tokens: [] as typeof response.items,
    nativeBalanceLamports: response.nativeBalance?.lamports || 0,
    nativeBalanceSOL: (response.nativeBalance?.lamports || 0) / 1e9,
  };

  for (const asset of response.items) {
    if (
      asset.interface === "FungibleToken" ||
      asset.interface === "FungibleAsset"
    ) {
      portfolio.tokens.push(asset);
    } else if (asset.compression?.compressed) {
      portfolio.compressedNfts.push(asset);
    } else {
      portfolio.nfts.push(asset);
    }
  }

  return portfolio;
}

/**
 * Check if wallet owns NFT from collection.
 */
export async function ownsNFTInCollection(
  walletAddress: string,
  collectionAddress: string
): Promise<boolean> {
  const response = await helius.searchAssets({
    ownerAddress: walletAddress,
    grouping: ["collection", collectionAddress],
    tokenType: "nonFungible",
    page: 1,
    limit: 1,
  });

  return response.total > 0;
}

// ============================================================================
// RPC Helpers
// ============================================================================

/**
 * Get SOL balance for an address.
 */
export async function getBalance(walletAddress: string): Promise<{
  lamports: bigint;
  sol: number;
}> {
  const addr = address(walletAddress);
  const { value } = await rpc.getBalance(addr).send();

  return {
    lamports: value,
    sol: Number(value) / Number(LAMPORTS_PER_SOL),
  };
}

/**
 * Get account info.
 */
export async function getAccountInfo(accountAddress: string) {
  const addr = address(accountAddress);
  const account = await fetchEncodedAccount(rpc, addr);

  if (account.exists) {
    return {
      exists: true,
      lamports: account.lamports,
      owner: account.programAddress,
      dataLength: account.data.length,
    };
  }

  return { exists: false };
}

/**
 * Get recent transactions for an address.
 */
export async function getRecentTransactions(
  walletAddress: string,
  limit = 10
) {
  const addr = address(walletAddress);
  const signatures = await rpc
    .getSignaturesForAddress(addr, {
      limit,
      commitment: "confirmed",
    })
    .send();

  return signatures;
}

// ============================================================================
// Enhanced Transaction Helpers
// ============================================================================

/**
 * Get parsed transaction history.
 */
export async function getParsedTransactionHistory(
  walletAddress: string,
  options?: {
    type?: string;
    source?: string;
    limit?: number;
  }
) {
  return helius.enhanced.getTransactionsByAddress({
    address: walletAddress,
    type: options?.type,
    source: options?.source,
  });
}

// ============================================================================
// Webhook Helpers
// ============================================================================

/**
 * Create a webhook to monitor addresses.
 */
export async function createMonitoringWebhook(
  webhookUrl: string,
  addresses: string[],
  transactionTypes: string[] = ["SWAP", "TRANSFER", "NFT_SALE"]
) {
  return helius.webhooks.createWebhook({
    webhookURL: webhookUrl,
    transactionTypes,
    accountAddresses: addresses,
    webhookType: "enhanced",
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Wait for transaction confirmation.
 */
export async function waitForConfirmation(
  signature: string,
  commitment: "processed" | "confirmed" | "finalized" = "confirmed"
): Promise<boolean> {
  const maxAttempts = 30;

  for (let i = 0; i < maxAttempts; i++) {
    const { value: statuses } = await rpc.getSignatureStatuses([signature]).send();
    const status = statuses[0];

    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }

      const isConfirmed =
        commitment === "processed"
          ? true
          : commitment === "confirmed"
          ? status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized"
          : status.confirmationStatus === "finalized";

      if (isConfirmed) {
        return true;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Transaction confirmation timeout");
}

/**
 * Check RPC health.
 */
export async function checkHealth() {
  const health = await rpc.getHealth().send();
  const version = await rpc.getVersion().send();
  const slot = await rpc.getSlot().send();

  return {
    healthy: health === "ok",
    version: version["solana-core"],
    slot,
  };
}

// ============================================================================
// Example Usage
// ============================================================================

async function example() {
  // Check health
  const health = await checkHealth();
  console.log("RPC Health:", health);

  // Get wallet balance
  const balance = await getBalance("YOUR_WALLET_ADDRESS");
  console.log("Balance:", balance.sol, "SOL");

  // Get NFTs
  const nfts = await getNFTsForWallet("YOUR_WALLET_ADDRESS");
  console.log("NFTs:", nfts.length);

  // Get complete portfolio
  const portfolio = await getWalletPortfolio("YOUR_WALLET_ADDRESS");
  console.log("Portfolio:", {
    nfts: portfolio.nfts.length,
    compressedNfts: portfolio.compressedNfts.length,
    tokens: portfolio.tokens.length,
    sol: portfolio.nativeBalanceSOL,
  });
}

// Run example if executed directly
if (require.main === module) {
  example().catch(console.error);
}
