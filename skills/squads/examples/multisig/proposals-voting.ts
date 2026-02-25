/**
 * Squads V4 Multisig: Proposals and Voting Example
 *
 * This example demonstrates the full lifecycle of proposals:
 * create, vote, approve, reject, cancel, and execute.
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

async function getNextTransactionIndex(
  connection: Connection,
  multisigPda: PublicKey
): Promise<bigint> {
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );
  return BigInt(Number(multisigAccount.transactionIndex) + 1);
}

// ============================================================================
// MAIN EXAMPLES
// ============================================================================

/**
 * Example 1: Create a vault transaction and proposal
 */
async function createTransactionAndProposal(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  recipientAddress: PublicKey,
  amountLamports: number
): Promise<{ transactionIndex: bigint; proposalPda: PublicKey }> {
  console.log("\n=== Creating Vault Transaction and Proposal ===");

  // Get the next transaction index
  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  console.log("Transaction index:", transactionIndex.toString());

  // Derive PDAs
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
  });
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });

  console.log("Vault:", vaultPda.toString());
  console.log("Transaction PDA:", transactionPda.toString());
  console.log("Proposal PDA:", proposalPda.toString());

  // Create the transfer instruction
  const transferIx = SystemProgram.transfer({
    fromPubkey: vaultPda,
    toPubkey: recipientAddress,
    lamports: amountLamports,
  });

  // Get recent blockhash for the transaction message
  const { blockhash } = await connection.getLatestBlockhash();

  // Create the vault transaction
  const createTxSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }),
  });

  console.log("Vault transaction created:", createTxSig);

  // Create the proposal
  const createProposalSig = await multisig.rpc.proposalCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer,
  });

  console.log("Proposal created:", createProposalSig);

  return { transactionIndex, proposalPda };
}

/**
 * Example 2: Approve a proposal
 */
async function approveProposal(
  connection: Connection,
  member: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<string> {
  console.log("\n=== Approving Proposal ===");

  const signature = await multisig.rpc.proposalApprove({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex,
    member,
    memo: "Approved via SDK", // Optional memo
  });

  console.log("Approval signature:", signature);
  return signature;
}

/**
 * Example 3: Reject a proposal
 */
async function rejectProposal(
  connection: Connection,
  member: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<string> {
  console.log("\n=== Rejecting Proposal ===");

  const signature = await multisig.rpc.proposalReject({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex,
    member,
    memo: "Rejected: Amount too high",
  });

  console.log("Rejection signature:", signature);
  return signature;
}

/**
 * Example 4: Cancel a proposal
 */
async function cancelProposal(
  connection: Connection,
  member: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<string> {
  console.log("\n=== Cancelling Proposal ===");

  const signature = await multisig.rpc.proposalCancel({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex,
    member,
    memo: "Cancelled: No longer needed",
  });

  console.log("Cancel signature:", signature);
  return signature;
}

/**
 * Example 5: Execute an approved vault transaction
 */
async function executeVaultTransaction(
  connection: Connection,
  executor: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<string> {
  console.log("\n=== Executing Vault Transaction ===");

  // Check if proposal is approved
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });

  const proposal = await multisig.accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda
  );

  if (proposal.status.__kind !== "Approved") {
    throw new Error(`Proposal is not approved. Status: ${proposal.status.__kind}`);
  }

  // Check time lock if applicable
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );

  if (multisigAccount.timeLock > 0 && proposal.status.__kind === "Approved") {
    const approvedAt = Number(proposal.status.timestamp);
    const currentTime = Math.floor(Date.now() / 1000);
    const timeRemaining = approvedAt + multisigAccount.timeLock - currentTime;

    if (timeRemaining > 0) {
      throw new Error(`Time lock not satisfied. ${timeRemaining} seconds remaining.`);
    }
  }

  // Execute the transaction
  const signature = await multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: executor,
    multisigPda,
    transactionIndex,
    member: executor.publicKey,
  });

  console.log("Execution signature:", signature);
  return signature;
}

/**
 * Example 6: Create a draft proposal (not immediately active)
 */
async function createDraftProposal(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<PublicKey> {
  console.log("\n=== Creating Draft Proposal ===");

  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });

  const signature = await multisig.rpc.proposalCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer,
    isDraft: true, // Create as draft
  });

  console.log("Draft proposal created:", signature);
  console.log("Proposal PDA:", proposalPda.toString());

  return proposalPda;
}

/**
 * Example 7: Activate a draft proposal
 */
async function activateDraftProposal(
  connection: Connection,
  member: Keypair,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<string> {
  console.log("\n=== Activating Draft Proposal ===");

  const signature = await multisig.rpc.proposalActivate({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex,
    member,
  });

  console.log("Proposal activated:", signature);
  return signature;
}

/**
 * Get proposal status and voting details
 */
async function getProposalStatus(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<void> {
  console.log("\n=== Proposal Status ===");

  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
  });

  const proposal = await multisig.accounts.Proposal.fromAccountAddress(
    connection,
    proposalPda
  );

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );

  console.log("Proposal:", proposalPda.toString());
  console.log("Status:", proposal.status.__kind);
  console.log("Threshold:", multisigAccount.threshold);
  console.log("Approved by:", proposal.approved.length, "members");
  console.log("Rejected by:", proposal.rejected.length, "members");
  console.log("Cancelled by:", proposal.cancelled.length, "members");

  if (proposal.approved.length > 0) {
    console.log("\nApprovers:");
    proposal.approved.forEach((pubkey) => console.log("  -", pubkey.toString()));
  }

  if (proposal.rejected.length > 0) {
    console.log("\nRejectors:");
    proposal.rejected.forEach((pubkey) => console.log("  -", pubkey.toString()));
  }

  // Check if ready to execute
  if (
    proposal.status.__kind === "Approved" ||
    proposal.approved.length >= multisigAccount.threshold
  ) {
    console.log("\n✓ Proposal has reached threshold and can be executed");

    if (multisigAccount.timeLock > 0 && proposal.status.__kind === "Approved") {
      const approvedAt = Number(proposal.status.timestamp);
      const currentTime = Math.floor(Date.now() / 1000);
      const timeRemaining = approvedAt + multisigAccount.timeLock - currentTime;

      if (timeRemaining > 0) {
        console.log(`⏱ Time lock: ${timeRemaining} seconds remaining`);
      } else {
        console.log("✓ Time lock satisfied");
      }
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads V4 Proposals and Voting Examples ===");

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");

  let wallet: Keypair;
  try {
    wallet = loadWallet(CONFIG.walletPath);
    console.log("Wallet loaded:", wallet.publicKey.toString());
  } catch {
    console.log("No wallet found. Create keypair.json to run examples.");
    return;
  }

  // You would replace this with your actual multisig PDA
  const multisigPda = new PublicKey("YOUR_MULTISIG_PDA_HERE");
  const recipientAddress = Keypair.generate().publicKey;

  console.log("\nMultisig:", multisigPda.toString());
  console.log("Recipient:", recipientAddress.toString());

  // Example flow:
  // 1. Create a transaction and proposal
  // 2. Have members vote
  // 3. Execute once threshold is met

  try {
    // Create transaction and proposal
    const { transactionIndex, proposalPda } = await createTransactionAndProposal(
      connection,
      wallet,
      multisigPda,
      recipientAddress,
      0.01 * LAMPORTS_PER_SOL
    );

    // First approval (creator auto-approves if they have vote permission)
    await approveProposal(connection, wallet, multisigPda, transactionIndex);

    // Check status
    await getProposalStatus(connection, multisigPda, transactionIndex);

    // If threshold is met, execute
    // await executeVaultTransaction(connection, wallet, multisigPda, transactionIndex);
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
