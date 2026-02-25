/**
 * PumpFun: Collect Creator Fees
 *
 * This example demonstrates how to collect accumulated creator fees
 * from both bonding curves and PumpSwap pools.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Load wallet
function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// Get creator vault PDA for bonding curve
function getBondingCurveCreatorVaultPDA(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

// Get creator vault authority PDA for PumpSwap
function getPumpSwapCreatorVaultAuthorityPDA(coinCreator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

// Check bonding curve creator vault balance
async function checkBondingCurveCreatorFees(
  connection: Connection,
  creator: PublicKey
): Promise<number> {
  const [creatorVault] = getBondingCurveCreatorVaultPDA(creator);

  const balance = await connection.getBalance(creatorVault);
  return balance;
}

// Check PumpSwap creator vault balance
async function checkPumpSwapCreatorFees(
  connection: Connection,
  coinCreator: PublicKey,
  quoteMint: PublicKey = WSOL_MINT
): Promise<number> {
  const [creatorVaultAuthority] = getPumpSwapCreatorVaultAuthorityPDA(coinCreator);

  const creatorVaultAta = getAssociatedTokenAddressSync(
    quoteMint,
    creatorVaultAuthority,
    true
  );

  try {
    const balance = await connection.getTokenAccountBalance(creatorVaultAta);
    return Number(balance.value.amount);
  } catch {
    return 0;
  }
}

// Collect creator fees from bonding curve
async function collectBondingCurveCreatorFee(
  connection: Connection,
  creator: Keypair
): Promise<string> {
  console.log('\n=== Collecting Bonding Curve Creator Fees ===');

  const [creatorVault] = getBondingCurveCreatorVaultPDA(creator.publicKey);

  // Check balance
  const balance = await connection.getBalance(creatorVault);
  console.log('Creator vault address:', creatorVault.toString());
  console.log('Available fees:', balance / 1e9, 'SOL');

  if (balance === 0) {
    console.log('No fees to collect');
    return '';
  }

  // Build collect_creator_fee instruction
  // Discriminator for 'collect_creator_fee'
  const discriminator = Buffer.from([0x85, 0xb1, 0x29, 0x6d, 0x3a, 0x47, 0x2c, 0x5e]);

  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });

  // Build and send transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  tx.add(instruction);

  tx.feePayer = creator.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  console.log('\nSending transaction...');
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [creator],
    { commitment: 'confirmed' }
  );

  console.log('\n=== Fees Collected Successfully ===');
  console.log('Signature:', signature);
  console.log('Collected:', balance / 1e9, 'SOL');

  return signature;
}

// Collect creator fees from PumpSwap pool
async function collectPumpSwapCreatorFee(
  connection: Connection,
  coinCreator: Keypair,
  pool: PublicKey,
  quoteMint: PublicKey = WSOL_MINT
): Promise<string> {
  console.log('\n=== Collecting PumpSwap Creator Fees ===');

  const [creatorVaultAuthority] = getPumpSwapCreatorVaultAuthorityPDA(coinCreator.publicKey);

  const creatorVaultAta = getAssociatedTokenAddressSync(
    quoteMint,
    creatorVaultAuthority,
    true
  );

  // Check balance
  let balance = 0;
  try {
    const balanceInfo = await connection.getTokenAccountBalance(creatorVaultAta);
    balance = Number(balanceInfo.value.amount);
  } catch {
    console.log('Creator vault ATA does not exist');
  }

  console.log('Creator vault authority:', creatorVaultAuthority.toString());
  console.log('Creator vault ATA:', creatorVaultAta.toString());
  console.log('Available fees:', balance / 1e9, 'tokens');

  if (balance === 0) {
    console.log('No fees to collect');
    return '';
  }

  // Get creator's wallet ATA
  const creatorWalletAta = getAssociatedTokenAddressSync(quoteMint, coinCreator.publicKey);

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Check if creator wallet ATA exists
  const creatorWalletAtaInfo = await connection.getAccountInfo(creatorWalletAta);
  if (!creatorWalletAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        coinCreator.publicKey,
        creatorWalletAta,
        coinCreator.publicKey,
        quoteMint
      )
    );
  }

  // Build collect_coin_creator_fee instruction
  const discriminator = Buffer.from([0xa3, 0x21, 0x67, 0x8e, 0xb4, 0x5c, 0x9f, 0x1d]);

  const instruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: coinCreator.publicKey, isSigner: true, isWritable: true },
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: creatorWalletAta, isSigner: false, isWritable: true },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });

  tx.add(instruction);

  tx.feePayer = coinCreator.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  console.log('\nSending transaction...');
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [coinCreator],
    { commitment: 'confirmed' }
  );

  console.log('\n=== Fees Collected Successfully ===');
  console.log('Signature:', signature);
  console.log('Collected:', balance / 1e9, 'tokens');

  return signature;
}

// Check all creator fees for a wallet
async function checkAllCreatorFees(
  connection: Connection,
  creator: PublicKey
): Promise<void> {
  console.log('\n=== Checking Creator Fees ===');
  console.log('Creator:', creator.toString());

  // Check bonding curve fees
  const bcFees = await checkBondingCurveCreatorFees(connection, creator);
  console.log('\nBonding Curve Fees:', bcFees / 1e9, 'SOL');

  // Check PumpSwap fees (WSOL)
  const swapFees = await checkPumpSwapCreatorFees(connection, creator, WSOL_MINT);
  console.log('PumpSwap Fees (WSOL):', swapFees / 1e9, 'SOL');

  const totalSol = (bcFees + swapFees) / 1e9;
  console.log('\nTotal collectable:', totalSol, 'SOL');
}

// Example usage
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const walletPath = process.env.WALLET_PATH || './keypair.json';
  const wallet = loadWallet(walletPath);
  console.log('Wallet:', wallet.publicKey.toString());

  // Check all fees
  await checkAllCreatorFees(connection, wallet.publicKey);

  // Collect bonding curve fees
  // await collectBondingCurveCreatorFee(connection, wallet);

  // Collect PumpSwap fees (requires pool address)
  // const pool = new PublicKey('YOUR_POOL_ADDRESS');
  // await collectPumpSwapCreatorFee(connection, wallet, pool);
}

main().catch(console.error);
