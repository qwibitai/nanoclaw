/**
 * Squads V4 Multisig: Vault Transactions Example
 *
 * This example demonstrates vault operations including:
 * - SOL transfers
 * - Token transfers
 * - Program invocations from vault
 * - Using ephemeral signers
 */

import * as multisig from "@sqds/multisig";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  walletPath: process.env.WALLET_PATH || "./keypair.json",
};

// Common token mints
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

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
 * Example 1: Transfer SOL from vault
 */
async function createSolTransfer(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  recipientAddress: PublicKey,
  amountSol: number
): Promise<bigint> {
  console.log("\n=== Creating SOL Transfer from Vault ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  console.log("Vault:", vaultPda.toString());
  console.log("Recipient:", recipientAddress.toString());
  console.log("Amount:", amountSol, "SOL");

  // Check vault balance
  const vaultBalance = await connection.getBalance(vaultPda);
  console.log("Vault balance:", vaultBalance / LAMPORTS_PER_SOL, "SOL");

  if (vaultBalance < amountSol * LAMPORTS_PER_SOL) {
    throw new Error("Insufficient vault balance");
  }

  // Create transfer instruction
  const transferIx = SystemProgram.transfer({
    fromPubkey: vaultPda,
    toPubkey: recipientAddress,
    lamports: amountSol * LAMPORTS_PER_SOL,
  });

  const { blockhash } = await connection.getLatestBlockhash();

  // Create vault transaction
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

  console.log("Transaction created:", createTxSig);
  console.log("Transaction index:", transactionIndex.toString());

  return transactionIndex;
}

/**
 * Example 2: Transfer SPL tokens from vault
 */
async function createTokenTransfer(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  tokenMint: PublicKey,
  recipientAddress: PublicKey,
  amount: number,
  decimals: number
): Promise<bigint> {
  console.log("\n=== Creating Token Transfer from Vault ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  // Get token accounts
  const vaultAta = getAssociatedTokenAddressSync(tokenMint, vaultPda, true);
  const recipientAta = getAssociatedTokenAddressSync(tokenMint, recipientAddress);

  console.log("Vault ATA:", vaultAta.toString());
  console.log("Recipient ATA:", recipientAta.toString());
  console.log("Amount:", amount);

  const instructions: TransactionInstruction[] = [];

  // Check if recipient ATA exists, if not create it
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    console.log("Creating recipient ATA...");
    instructions.push(
      createAssociatedTokenAccountInstruction(
        vaultPda, // payer (vault pays for ATA creation)
        recipientAta,
        recipientAddress,
        tokenMint
      )
    );
  }

  // Create transfer instruction
  const transferAmount = BigInt(amount * Math.pow(10, decimals));
  instructions.push(
    createTransferInstruction(
      vaultAta,
      recipientAta,
      vaultPda, // authority
      transferAmount
    )
  );

  const { blockhash } = await connection.getLatestBlockhash();

  // Create vault transaction
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
      instructions,
    }),
  });

  console.log("Token transfer created:", createTxSig);
  console.log("Transaction index:", transactionIndex.toString());

  return transactionIndex;
}

/**
 * Example 3: Transfer from a different vault index
 */
async function createTransferFromVault(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  vaultIndex: number,
  recipientAddress: PublicKey,
  amountSol: number
): Promise<bigint> {
  console.log(`\n=== Creating Transfer from Vault ${vaultIndex} ===`);

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: vaultIndex });

  console.log(`Vault ${vaultIndex}:`, vaultPda.toString());

  const transferIx = SystemProgram.transfer({
    fromPubkey: vaultPda,
    toPubkey: recipientAddress,
    lamports: amountSol * LAMPORTS_PER_SOL,
  });

  const { blockhash } = await connection.getLatestBlockhash();

  const createTxSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    vaultIndex, // Use different vault
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }),
  });

  console.log("Transaction created:", createTxSig);

  return transactionIndex;
}

/**
 * Example 4: Using ephemeral signers for CPI
 * Useful when the vault needs to sign as a different PDA
 */
async function createTransactionWithEphemeralSigner(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  instructions: TransactionInstruction[]
): Promise<bigint> {
  console.log("\n=== Creating Transaction with Ephemeral Signer ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  // Derive ephemeral signer PDA
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
  });

  const [ephemeralSignerPda] = multisig.getEphemeralSignerPda({
    transactionPda,
    ephemeralSignerIndex: 0,
  });

  console.log("Ephemeral signer:", ephemeralSignerPda.toString());

  const { blockhash } = await connection.getLatestBlockhash();

  const createTxSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer,
    multisigPda,
    transactionIndex,
    creator: feePayer.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 1, // Request 1 ephemeral signer
    transactionMessage: new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: blockhash,
      instructions,
    }),
  });

  console.log("Transaction with ephemeral signer created:", createTxSig);

  return transactionIndex;
}

/**
 * Example 5: Multi-instruction transaction
 */
async function createMultiInstructionTransaction(
  connection: Connection,
  feePayer: Keypair,
  multisigPda: PublicKey,
  recipients: { address: PublicKey; amountSol: number }[]
): Promise<bigint> {
  console.log("\n=== Creating Multi-Instruction Transaction ===");

  const transactionIndex = await getNextTransactionIndex(connection, multisigPda);
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  // Create multiple transfer instructions
  const instructions = recipients.map((recipient) =>
    SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: recipient.address,
      lamports: recipient.amountSol * LAMPORTS_PER_SOL,
    })
  );

  console.log(`Creating ${instructions.length} transfers in one transaction`);

  const { blockhash } = await connection.getLatestBlockhash();

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
      instructions,
    }),
  });

  console.log("Multi-instruction transaction created:", createTxSig);

  return transactionIndex;
}

/**
 * Get vault transaction details
 */
async function getVaultTransactionInfo(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint
): Promise<void> {
  console.log("\n=== Vault Transaction Info ===");

  const [transactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
  });

  const vaultTransaction =
    await multisig.accounts.VaultTransaction.fromAccountAddress(
      connection,
      transactionPda
    );

  console.log("Transaction PDA:", transactionPda.toString());
  console.log("Creator:", vaultTransaction.creator.toString());
  console.log("Index:", vaultTransaction.index.toString());
  console.log("Vault Index:", vaultTransaction.vaultIndex);
  console.log("Ephemeral Signers:", vaultTransaction.ephemeralSignerBumps.length);
}

/**
 * Check all vault balances
 */
async function checkVaultBalances(
  connection: Connection,
  multisigPda: PublicKey,
  maxVaultIndex: number = 3
): Promise<void> {
  console.log("\n=== Vault Balances ===");

  for (let i = 0; i <= maxVaultIndex; i++) {
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: i });
    const balance = await connection.getBalance(vaultPda);

    if (balance > 0 || i === 0) {
      console.log(`Vault ${i}: ${vaultPda.toString()}`);
      console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("=== Squads V4 Vault Transactions Examples ===");

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");

  let wallet: Keypair;
  try {
    wallet = loadWallet(CONFIG.walletPath);
    console.log("Wallet loaded:", wallet.publicKey.toString());
  } catch {
    console.log("No wallet found. Create keypair.json to run examples.");
    return;
  }

  // Replace with your actual multisig PDA
  const multisigPda = new PublicKey("YOUR_MULTISIG_PDA_HERE");

  try {
    // Check vault balances
    await checkVaultBalances(connection, multisigPda);

    // Example: Create a SOL transfer
    const recipient = Keypair.generate().publicKey;
    const transactionIndex = await createSolTransfer(
      connection,
      wallet,
      multisigPda,
      recipient,
      0.01 // 0.01 SOL
    );

    // Get transaction info
    await getVaultTransactionInfo(connection, multisigPda, transactionIndex);

    // Don't forget to create a proposal and get votes!
    console.log("\n=== Next Steps ===");
    console.log("1. Create a proposal for this transaction");
    console.log("2. Have members vote to approve");
    console.log("3. Execute once threshold is met");
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
