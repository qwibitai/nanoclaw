/**
 * Solana Kit Project Template
 *
 * A production-ready starter template for Solana applications using @solana/kit.
 *
 * Setup:
 *   npm install @solana/kit @solana-program/system @solana-program/token @solana-program/compute-budget
 *
 * Run:
 *   npx ts-node project-template.ts
 */

import {
  // RPC
  createSolanaRpc,
  createSolanaRpcSubscriptions,

  // Signers
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  type KeyPairSigner,

  // Addresses
  address,
  type Address,

  // Transactions
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  prependTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  sendTransactionWithoutConfirmingFactory,
  airdropFactory,

  // Accounts
  fetchEncodedAccount,
  fetchEncodedAccounts,
  assertAccountExists,

  // Utilities
  lamports,
  type Lamports,
  type Rpc,
  type RpcSubscriptions,
} from "@solana/kit";

import { getTransferSolInstruction } from "@solana-program/system";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

// ============================================================================
// CONFIGURATION
// ============================================================================

interface Config {
  rpcUrl: string;
  wsUrl: string;
  network: "mainnet-beta" | "devnet" | "testnet" | "localnet";
  defaultCommitment: "processed" | "confirmed" | "finalized";
  defaultPriorityFee: bigint;  // microLamports
  defaultComputeUnits: number;
}

const CONFIGS: Record<string, Config> = {
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    wsUrl: "wss://api.devnet.solana.com",
    network: "devnet",
    defaultCommitment: "confirmed",
    defaultPriorityFee: 1000n,
    defaultComputeUnits: 200_000,
  },
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    wsUrl: "wss://api.mainnet-beta.solana.com",
    network: "mainnet-beta",
    defaultCommitment: "confirmed",
    defaultPriorityFee: 10000n,
    defaultComputeUnits: 200_000,
  },
  localnet: {
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    network: "localnet",
    defaultCommitment: "confirmed",
    defaultPriorityFee: 0n,
    defaultComputeUnits: 200_000,
  },
};

const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

// ============================================================================
// SOLANA CLIENT
// ============================================================================

class SolanaClient {
  public readonly rpc: Rpc;
  public readonly rpcSubscriptions: RpcSubscriptions;
  public readonly config: Config;

  private sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  private sendWithoutConfirm: ReturnType<typeof sendTransactionWithoutConfirmingFactory>;
  private airdrop: ReturnType<typeof airdropFactory>;

  constructor(configName: keyof typeof CONFIGS = "devnet") {
    this.config = CONFIGS[configName];
    this.rpc = createSolanaRpc(this.config.rpcUrl);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(this.config.wsUrl);

    this.sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });
    this.sendWithoutConfirm = sendTransactionWithoutConfirmingFactory({
      rpc: this.rpc,
    });
    this.airdrop = airdropFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    });
  }

  // ---------------------------------------------------------------------------
  // Wallet Management
  // ---------------------------------------------------------------------------

  async generateWallet(): Promise<KeyPairSigner> {
    return generateKeyPairSigner();
  }

  async loadWallet(secretKey: Uint8Array): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(secretKey);
  }

  // ---------------------------------------------------------------------------
  // Balance Operations
  // ---------------------------------------------------------------------------

  async getBalance(addr: Address): Promise<Lamports> {
    const result = await this.rpc.getBalance(addr).send();
    return result.value;
  }

  async getBalanceSol(addr: Address): Promise<number> {
    const lamportBalance = await this.getBalance(addr);
    return Number(lamportBalance) / Number(LAMPORTS_PER_SOL);
  }

  // ---------------------------------------------------------------------------
  // Transaction Building
  // ---------------------------------------------------------------------------

  async buildTransaction(
    feePayer: KeyPairSigner,
    instructions: any[],
    options?: {
      priorityFee?: bigint;
      computeUnits?: number;
    }
  ) {
    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();

    const priorityFee = options?.priorityFee ?? this.config.defaultPriorityFee;
    const computeUnits = options?.computeUnits ?? this.config.defaultComputeUnits;

    const computeBudgetInstructions = [
      getSetComputeUnitLimitInstruction({ units: computeUnits }),
      getSetComputeUnitPriceInstruction({ microLamports: priorityFee }),
    ];

    return pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => prependTransactionMessageInstructions(computeBudgetInstructions, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    );
  }

  // ---------------------------------------------------------------------------
  // Transaction Sending
  // ---------------------------------------------------------------------------

  async signAndSend(
    transactionMessage: any,
    options?: {
      skipPreflight?: boolean;
      maxRetries?: number;
    }
  ): Promise<string> {
    const signedTx = await signTransactionMessageWithSigners(transactionMessage);
    const signature = getSignatureFromTransaction(signedTx);

    await this.sendAndConfirm(signedTx, {
      commitment: this.config.defaultCommitment,
      skipPreflight: options?.skipPreflight ?? false,
    });

    return signature;
  }

  async signAndSendWithRetry(
    transactionMessage: any,
    maxRetries = 3
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.signAndSend(transactionMessage);
      } catch (error: any) {
        lastError = error;

        // Retry on blockhash expiration
        if (error.message?.includes("blockhash")) {
          console.log(`Blockhash expired, retrying (${attempt + 1}/${maxRetries})`);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // SOL Transfer
  // ---------------------------------------------------------------------------

  async transferSol(
    from: KeyPairSigner,
    to: Address,
    amountSol: number
  ): Promise<string> {
    const amountLamports = lamports(BigInt(Math.floor(amountSol * 1e9)));

    const instruction = getTransferSolInstruction({
      source: from,
      destination: to,
      amount: amountLamports,
    });

    const tx = await this.buildTransaction(from, [instruction]);
    return this.signAndSend(tx);
  }

  // ---------------------------------------------------------------------------
  // Account Fetching
  // ---------------------------------------------------------------------------

  async getAccount(addr: Address) {
    const account = await fetchEncodedAccount(this.rpc, addr);
    return account.exists ? account : null;
  }

  async getAccounts(addresses: Address[]) {
    const accounts = await fetchEncodedAccounts(this.rpc, addresses);
    return accounts.map((acc, i) => ({
      address: addresses[i],
      account: acc.exists ? acc : null,
    }));
  }

  // ---------------------------------------------------------------------------
  // Devnet Utilities
  // ---------------------------------------------------------------------------

  async requestAirdrop(recipient: Address, amountSol: number): Promise<void> {
    if (this.config.network !== "devnet" && this.config.network !== "localnet") {
      throw new Error("Airdrop only available on devnet/localnet");
    }

    await this.airdrop({
      commitment: this.config.defaultCommitment,
      lamports: lamports(BigInt(Math.floor(amountSol * 1e9))),
      recipientAddress: recipient,
    });
  }

  // ---------------------------------------------------------------------------
  // Network Info
  // ---------------------------------------------------------------------------

  async getSlot(): Promise<bigint> {
    return this.rpc.getSlot().send();
  }

  async getBlockHeight(): Promise<bigint> {
    return this.rpc.getBlockHeight().send();
  }

  async getRecentBlockhash() {
    const { value } = await this.rpc.getLatestBlockhash().send();
    return value;
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  // Initialize client
  const client = new SolanaClient("devnet");
  console.log("Connected to:", client.config.network);

  // Generate wallets
  const sender = await client.generateWallet();
  const recipient = await client.generateWallet();
  console.log("Sender:", sender.address);
  console.log("Recipient:", recipient.address);

  // Fund sender (devnet only)
  console.log("Requesting airdrop...");
  await client.requestAirdrop(sender.address, 2);

  // Check balance
  const balance = await client.getBalanceSol(sender.address);
  console.log("Sender balance:", balance, "SOL");

  // Transfer SOL
  console.log("Transferring 0.5 SOL...");
  const signature = await client.transferSol(sender, recipient.address, 0.5);
  console.log("Transfer signature:", signature);

  // Verify
  const recipientBalance = await client.getBalanceSol(recipient.address);
  console.log("Recipient balance:", recipientBalance, "SOL");

  // Get account info
  const accountInfo = await client.getAccount(recipient.address);
  if (accountInfo) {
    console.log("Account lamports:", accountInfo.lamports);
    console.log("Account owner:", accountInfo.programAddress);
  }

  console.log("\nDone!");
}

// Run if executed directly
main().catch(console.error);

// Export for use as module
export { SolanaClient, Config, CONFIGS, LAMPORTS_PER_SOL };
