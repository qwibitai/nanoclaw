/**
 * PumpFun: Buy and Sell on Bonding Curve
 *
 * This example demonstrates how to buy and sell tokens on a PumpFun bonding curve.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
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
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Bonding curve state interface
interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
}

// PDA derivation
function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

function getAssociatedBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('associated-bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

function getGlobalPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM_ID
  );
}

function getCreatorVaultPDA(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

function getFeeConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    PUMP_FEES_PROGRAM_ID
  );
}

// Parse bonding curve account data
function parseBondingCurve(data: Buffer): BondingCurveState {
  // Skip discriminator (8 bytes)
  let offset = 8;

  const virtualTokenReserves = data.readBigUInt64LE(offset);
  offset += 8;

  const virtualSolReserves = data.readBigUInt64LE(offset);
  offset += 8;

  const realTokenReserves = data.readBigUInt64LE(offset);
  offset += 8;

  const realSolReserves = data.readBigUInt64LE(offset);
  offset += 8;

  const tokenTotalSupply = data.readBigUInt64LE(offset);
  offset += 8;

  const complete = data.readUInt8(offset) === 1;
  offset += 1;

  const creator = new PublicKey(data.slice(offset, offset + 32));

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
  };
}

// Calculate buy quote
function calculateBuyQuote(
  state: BondingCurveState,
  solAmountIn: bigint,
  feeBps: bigint = 100n
): bigint {
  // Deduct fee
  const netSol = (solAmountIn * 10000n) / (10000n + feeBps);

  // Constant product formula
  const tokensOut = (netSol * state.virtualTokenReserves) /
                    (state.virtualSolReserves + netSol);

  // Cap at real reserves
  return tokensOut > state.realTokenReserves ? state.realTokenReserves : tokensOut;
}

// Calculate sell quote
function calculateSellQuote(
  state: BondingCurveState,
  tokenAmountIn: bigint,
  feeBps: bigint = 100n
): bigint {
  // Constant product formula
  const grossSol = (tokenAmountIn * state.virtualSolReserves) /
                   (state.virtualTokenReserves + tokenAmountIn);

  // Deduct fee
  const netSol = (grossSol * (10000n - feeBps)) / 10000n;

  // Cap at real reserves
  return netSol > state.realSolReserves ? state.realSolReserves : netSol;
}

// Load wallet
function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// Buy tokens
async function buyTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  solAmount: bigint,
  slippageBps: number = 500 // 5% default
): Promise<string> {
  console.log('\n=== Buying Tokens ===');
  console.log('Mint:', mint.toString());
  console.log('SOL amount:', Number(solAmount) / 1e9, 'SOL');

  // Derive PDAs
  const [bondingCurve] = getBondingCurvePDA(mint);
  const [associatedBondingCurve] = getAssociatedBondingCurvePDA(mint);
  const [global] = getGlobalPDA();
  const [feeConfig] = getFeeConfigPDA();

  // Fetch bonding curve state
  const bondingCurveInfo = await connection.getAccountInfo(bondingCurve);
  if (!bondingCurveInfo) {
    throw new Error('Bonding curve not found');
  }

  const state = parseBondingCurve(bondingCurveInfo.data);
  if (state.complete) {
    throw new Error('Bonding curve is complete. Trade on PumpSwap instead.');
  }

  console.log('Bonding curve state:');
  console.log('  Virtual token reserves:', state.virtualTokenReserves.toString());
  console.log('  Virtual SOL reserves:', state.virtualSolReserves.toString());

  // Calculate expected tokens
  const expectedTokens = calculateBuyQuote(state, solAmount);
  console.log('Expected tokens:', expectedTokens.toString());

  // Calculate max SOL with slippage
  const maxSolCost = solAmount + (solAmount * BigInt(slippageBps) / 10000n);
  console.log('Max SOL cost (with slippage):', Number(maxSolCost) / 1e9, 'SOL');

  // Get creator vault
  const [creatorVault] = getCreatorVaultPDA(state.creator);

  // Get user ATA
  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

  // Fee recipient (in production, get from global config)
  const feeRecipient = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

  // Build transaction
  const tx = new Transaction();

  // Add compute budget
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Check if user ATA exists, create if not
  const userAtaInfo = await connection.getAccountInfo(userAta);
  if (!userAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userAta,
        payer.publicKey,
        mint
      )
    );
  }

  // Check if account extension needed
  if (bondingCurveInfo.data.length < 150) {
    // Add extend_account instruction
    const extendDiscriminator = Buffer.from([0x9a, 0x3f, 0x2c, 0x8b, 0x45, 0xe7, 0x12, 0xd6]);
    tx.add(
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [{ pubkey: bondingCurve, isSigner: false, isWritable: true }],
        data: extendDiscriminator,
      })
    );
  }

  // Build buy instruction
  const buyDiscriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
  const buyData = Buffer.alloc(8 + 8 + 8);
  buyDiscriminator.copy(buyData, 0);
  buyData.writeBigUInt64LE(expectedTokens, 8);
  buyData.writeBigUInt64LE(maxSolCost, 16);

  const buyInstruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
    ],
    data: buyData,
  });

  tx.add(buyInstruction);

  // Send transaction
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  console.log('\nSending transaction...');
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer],
    { commitment: 'confirmed' }
  );

  console.log('\n=== Buy Successful ===');
  console.log('Signature:', signature);

  return signature;
}

// Sell tokens
async function sellTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  tokenAmount: bigint,
  slippageBps: number = 500
): Promise<string> {
  console.log('\n=== Selling Tokens ===');
  console.log('Mint:', mint.toString());
  console.log('Token amount:', tokenAmount.toString());

  // Derive PDAs
  const [bondingCurve] = getBondingCurvePDA(mint);
  const [associatedBondingCurve] = getAssociatedBondingCurvePDA(mint);
  const [global] = getGlobalPDA();
  const [feeConfig] = getFeeConfigPDA();

  // Fetch bonding curve state
  const bondingCurveInfo = await connection.getAccountInfo(bondingCurve);
  if (!bondingCurveInfo) {
    throw new Error('Bonding curve not found');
  }

  const state = parseBondingCurve(bondingCurveInfo.data);
  if (state.complete) {
    throw new Error('Bonding curve is complete. Trade on PumpSwap instead.');
  }

  // Calculate expected SOL
  const expectedSol = calculateSellQuote(state, tokenAmount);
  console.log('Expected SOL:', Number(expectedSol) / 1e9, 'SOL');

  // Calculate min SOL with slippage
  const minSolOutput = expectedSol - (expectedSol * BigInt(slippageBps) / 10000n);
  console.log('Min SOL output (with slippage):', Number(minSolOutput) / 1e9, 'SOL');

  // Get creator vault
  const [creatorVault] = getCreatorVaultPDA(state.creator);

  // Get user ATA
  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const feeRecipient = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Build sell instruction
  const sellDiscriminator = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
  const sellData = Buffer.alloc(8 + 8 + 8);
  sellDiscriminator.copy(sellData, 0);
  sellData.writeBigUInt64LE(tokenAmount, 8);
  sellData.writeBigUInt64LE(minSolOutput, 16);

  const sellInstruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
    ],
    data: sellData,
  });

  tx.add(sellInstruction);

  // Send transaction
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  console.log('\nSending transaction...');
  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer],
    { commitment: 'confirmed' }
  );

  console.log('\n=== Sell Successful ===');
  console.log('Signature:', signature);

  return signature;
}

// Example usage
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const walletPath = process.env.WALLET_PATH || './keypair.json';
  const wallet = loadWallet(walletPath);
  console.log('Wallet:', wallet.publicKey.toString());

  // Example mint address (replace with actual)
  const mint = new PublicKey('YOUR_TOKEN_MINT_ADDRESS');

  // Buy 0.01 SOL worth of tokens
  await buyTokens(connection, wallet, mint, BigInt(0.01 * 1e9));

  // Sell 1000 tokens
  // await sellTokens(connection, wallet, mint, 1000n);
}

main().catch(console.error);
