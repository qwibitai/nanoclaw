/**
 * Squads V4 Multisig Setup Template
 *
 * Ready-to-use client for multisig operations.
 * Copy this file and customize for your project.
 *
 * Usage:
 * 1. Install dependencies: npm install @sqds/multisig @solana/web3.js
 * 2. Update CONFIG with your settings
 * 3. Run with: npx ts-node multisig-setup.ts
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  Commitment,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const { Permission, Permissions } = multisig.types;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC endpoint
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",

  // Commitment level
  commitment: "confirmed" as Commitment,

  // Wallet keypair path
  walletPath: process.env.WALLET_PATH || "./keypair.json",

  // Your multisig PDA (set after creating)
  multisigPda: process.env.MULTISIG_PDA || "",

  // Default vault index
  defaultVaultIndex: 0,
};

// ============================================================================
// TYPES
// ============================================================================

export interface MultisigMember {
  address: PublicKey;
  permissions: {
    initiate: boolean;
    vote: boolean;
    execute: boolean;
  };
}

export interface TransactionResult {
  signature: string;
  success: boolean;
  error?: string;
}

export interface ProposalInfo {
  pda: PublicKey;
  transactionIndex: bigint;
  status: string;
  approvals: number;
  rejections: number;
  threshold: number;
  canExecute: boolean;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function loadWallet(walletPath: string): Keypair {
  const resolvedPath = path.resolve(walletPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Wallet file not found: ${resolvedPath}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SQUADS MULTISIG CLIENT
// ============================================================================

export class SquadsMultisigClient {
  private connection: Connection;
  private wallet: Keypair;
  private multisigPda: PublicKey | null;

  constructor(config?: {
    rpcUrl?: string;
    commitment?: Commitment;
    wallet?: Keypair;
    multisigPda?: string;
  }) {
    this.connection = new Connection(
      config?.rpcUrl || CONFIG.rpcUrl,
      config?.commitment || CONFIG.commitment
    );

    this.wallet = config?.wallet || loadWallet(CONFIG.walletPath);

    this.multisigPda = config?.multisigPda || CONFIG.multisigPda
      ? new PublicKey(config?.multisigPda || CONFIG.multisigPda)
      : null;
  }

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  get walletAddress(): PublicKey {
    return this.wallet.publicKey;
  }

  get rpc(): Connection {
    return this.connection;
  }

  get multisig(): PublicKey {
    if (!this.multisigPda) {
      throw new Error("Multisig PDA not set. Create or set a multisig first.");
    }
    return this.multisigPda;
  }

  // --------------------------------------------------------------------------
  // Multisig Creation
  // --------------------------------------------------------------------------

  async createMultisig(params: {
    members: { address: PublicKey; permissions: ("initiate" | "vote" | "execute")[] }[];
    threshold: number;
    timeLock?: number;
    rentCollector?: PublicKey;
  }): Promise<{ multisigPda: PublicKey; vaultPda: PublicKey; signature: string }> {
    const createKey = Keypair.generate();

    const [multisigPda] = multisig.getMultisigPda({
      createKey: createKey.publicKey,
    });

    const [vaultPda] = multisig.getVaultPda({
      multisigPda,
      index: CONFIG.defaultVaultIndex,
    });

    const members = params.members.map((m) => ({
      key: m.address,
      permissions: Permissions.fromPermissions(
        m.permissions.map((p) => {
          switch (p) {
            case "initiate": return Permission.Initiate;
            case "vote": return Permission.Vote;
            case "execute": return Permission.Execute;
          }
        })
      ),
    }));

    const signature = await multisig.rpc.multisigCreateV2({
      connection: this.connection,
      createKey,
      creator: this.wallet,
      multisigPda,
      configAuthority: null,
      threshold: params.threshold,
      members,
      timeLock: params.timeLock || 0,
      rentCollector: params.rentCollector || null,
    });

    this.multisigPda = multisigPda;

    return { multisigPda, vaultPda, signature };
  }

  // --------------------------------------------------------------------------
  // Vault Operations
  // --------------------------------------------------------------------------

  getVaultPda(index: number = CONFIG.defaultVaultIndex): PublicKey {
    const [vaultPda] = multisig.getVaultPda({
      multisigPda: this.multisig,
      index,
    });
    return vaultPda;
  }

  async getVaultBalance(index: number = CONFIG.defaultVaultIndex): Promise<number> {
    const vaultPda = this.getVaultPda(index);
    const balance = await this.connection.getBalance(vaultPda);
    return balance / LAMPORTS_PER_SOL;
  }

  // --------------------------------------------------------------------------
  // Transaction Creation
  // --------------------------------------------------------------------------

  async createVaultTransaction(
    instructions: TransactionInstruction[],
    vaultIndex: number = CONFIG.defaultVaultIndex
  ): Promise<{ transactionIndex: bigint; signature: string }> {
    const multisigAccount = await this.getMultisigAccount();
    const transactionIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);

    const vaultPda = this.getVaultPda(vaultIndex);
    const { blockhash } = await this.connection.getLatestBlockhash();

    const signature = await multisig.rpc.vaultTransactionCreate({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      creator: this.wallet.publicKey,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: blockhash,
        instructions,
      }),
    });

    return { transactionIndex, signature };
  }

  // --------------------------------------------------------------------------
  // Proposal Management
  // --------------------------------------------------------------------------

  async createProposal(transactionIndex: bigint): Promise<string> {
    return multisig.rpc.proposalCreate({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      creator: this.wallet,
    });
  }

  async approveProposal(transactionIndex: bigint, memo?: string): Promise<string> {
    return multisig.rpc.proposalApprove({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      member: this.wallet,
      memo,
    });
  }

  async rejectProposal(transactionIndex: bigint, memo?: string): Promise<string> {
    return multisig.rpc.proposalReject({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      member: this.wallet,
      memo,
    });
  }

  async cancelProposal(transactionIndex: bigint, memo?: string): Promise<string> {
    return multisig.rpc.proposalCancel({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      member: this.wallet,
      memo,
    });
  }

  async executeVaultTransaction(transactionIndex: bigint): Promise<string> {
    return multisig.rpc.vaultTransactionExecute({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      member: this.wallet.publicKey,
    });
  }

  // --------------------------------------------------------------------------
  // Account Info
  // --------------------------------------------------------------------------

  async getMultisigAccount() {
    return multisig.accounts.Multisig.fromAccountAddress(
      this.connection,
      this.multisig
    );
  }

  async getProposalInfo(transactionIndex: bigint): Promise<ProposalInfo> {
    const [proposalPda] = multisig.getProposalPda({
      multisigPda: this.multisig,
      transactionIndex,
    });

    const [proposal, multisigAccount] = await Promise.all([
      multisig.accounts.Proposal.fromAccountAddress(this.connection, proposalPda),
      this.getMultisigAccount(),
    ]);

    const canExecute =
      proposal.status.__kind === "Approved" ||
      proposal.approved.length >= multisigAccount.threshold;

    return {
      pda: proposalPda,
      transactionIndex,
      status: proposal.status.__kind,
      approvals: proposal.approved.length,
      rejections: proposal.rejected.length,
      threshold: multisigAccount.threshold,
      canExecute,
    };
  }

  async getMembers(): Promise<MultisigMember[]> {
    const multisigAccount = await this.getMultisigAccount();

    return multisigAccount.members.map((m) => ({
      address: m.key,
      permissions: {
        initiate: (m.permissions.mask & Permission.Initiate) !== 0,
        vote: (m.permissions.mask & Permission.Vote) !== 0,
        execute: (m.permissions.mask & Permission.Execute) !== 0,
      },
    }));
  }

  // --------------------------------------------------------------------------
  // Config Transactions
  // --------------------------------------------------------------------------

  async addMember(
    newMember: PublicKey,
    permissions: ("initiate" | "vote" | "execute")[]
  ): Promise<{ transactionIndex: bigint; signature: string }> {
    const multisigAccount = await this.getMultisigAccount();
    const transactionIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);

    const permissionFlags = Permissions.fromPermissions(
      permissions.map((p) => {
        switch (p) {
          case "initiate": return Permission.Initiate;
          case "vote": return Permission.Vote;
          case "execute": return Permission.Execute;
        }
      })
    );

    const signature = await multisig.rpc.configTransactionCreate({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      creator: this.wallet.publicKey,
      actions: [
        {
          __kind: "AddMember",
          newMember: { key: newMember, permissions: permissionFlags },
        },
      ],
    });

    return { transactionIndex, signature };
  }

  async removeMember(
    memberToRemove: PublicKey
  ): Promise<{ transactionIndex: bigint; signature: string }> {
    const multisigAccount = await this.getMultisigAccount();
    const transactionIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);

    const signature = await multisig.rpc.configTransactionCreate({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      creator: this.wallet.publicKey,
      actions: [
        {
          __kind: "RemoveMember",
          oldMember: memberToRemove,
        },
      ],
    });

    return { transactionIndex, signature };
  }

  async changeThreshold(
    newThreshold: number
  ): Promise<{ transactionIndex: bigint; signature: string }> {
    const multisigAccount = await this.getMultisigAccount();
    const transactionIndex = BigInt(Number(multisigAccount.transactionIndex) + 1);

    const signature = await multisig.rpc.configTransactionCreate({
      connection: this.connection,
      feePayer: this.wallet,
      multisigPda: this.multisig,
      transactionIndex,
      creator: this.wallet.publicKey,
      actions: [
        {
          __kind: "ChangeThreshold",
          newThreshold,
        },
      ],
    });

    return { transactionIndex, signature };
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  console.log("=== Squads Multisig Setup ===\n");

  // Initialize client
  const client = new SquadsMultisigClient();
  console.log("Wallet:", client.walletAddress.toString());

  // Check balance
  const balance = await client.rpc.getBalance(client.walletAddress);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  // If no multisig set, show how to create one
  if (!CONFIG.multisigPda) {
    console.log("\nNo multisig configured. Create one with:");
    console.log(`
const { multisigPda, vaultPda } = await client.createMultisig({
  members: [
    { address: member1, permissions: ["initiate", "vote", "execute"] },
    { address: member2, permissions: ["vote"] },
  ],
  threshold: 2,
});

console.log("Multisig:", multisigPda.toString());
console.log("Vault:", vaultPda.toString());
`);
    return;
  }

  // Get multisig info
  const members = await client.getMembers();
  console.log("\nMultisig Members:");
  members.forEach((m, i) => {
    const perms = [];
    if (m.permissions.initiate) perms.push("Initiate");
    if (m.permissions.vote) perms.push("Vote");
    if (m.permissions.execute) perms.push("Execute");
    console.log(`  ${i + 1}. ${m.address.toString()}`);
    console.log(`     Permissions: ${perms.join(", ")}`);
  });

  // Get vault balance
  const vaultBalance = await client.getVaultBalance();
  console.log("\nVault Balance:", vaultBalance, "SOL");
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
