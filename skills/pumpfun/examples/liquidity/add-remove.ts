/**
 * PumpFun: Add and Remove Liquidity on PumpSwap
 *
 * This example demonstrates how to add and remove liquidity on PumpSwap AMM.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';

// Program IDs
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Pool state interface
interface PoolState {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
}

// Load wallet
function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// Parse pool state (simplified)
function parsePoolState(data: Buffer): PoolState {
  let offset = 9; // Skip discriminator + bump

  const poolCreator = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const baseMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const quoteMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const lpMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const poolBaseTokenAccount = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const poolQuoteTokenAccount = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const lpSupply = data.readBigUInt64LE(offset);

  return {
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
  };
}

// Calculate LP tokens for deposit
function calculateLpTokensForDeposit(
  baseAmount: bigint,
  quoteAmount: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  lpSupply: bigint
): bigint {
  if (lpSupply === 0n) {
    // Initial liquidity - use geometric mean
    return BigInt(Math.floor(Math.sqrt(Number(baseAmount * quoteAmount))));
  }

  // Calculate LP tokens based on proportional contribution
  const lpFromBase = (baseAmount * lpSupply) / baseReserve;
  const lpFromQuote = (quoteAmount * lpSupply) / quoteReserve;

  // Return the minimum to ensure balanced deposit
  return lpFromBase < lpFromQuote ? lpFromBase : lpFromQuote;
}

// Calculate tokens for withdrawal
function calculateWithdrawalAmounts(
  lpTokens: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  lpSupply: bigint
): { baseAmount: bigint; quoteAmount: bigint } {
  const baseAmount = (lpTokens * baseReserve) / lpSupply;
  const quoteAmount = (lpTokens * quoteReserve) / lpSupply;

  return { baseAmount, quoteAmount };
}

// Add liquidity to pool
async function addLiquidity(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  baseAmount: bigint,
  quoteAmount: bigint,
  slippageBps: number = 500
): Promise<string> {
  console.log('\n=== Adding Liquidity ===');

  // Fetch pool state
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error('Pool not found');
  }

  const poolState = parsePoolState(poolInfo.data);
  console.log('Pool:', pool.toString());
  console.log('Base mint:', poolState.baseMint.toString());
  console.log('Quote mint:', poolState.quoteMint.toString());
  console.log('LP mint:', poolState.lpMint.toString());

  // Get pool reserves
  const baseReserve = await connection.getTokenAccountBalance(poolState.poolBaseTokenAccount);
  const quoteReserve = await connection.getTokenAccountBalance(poolState.poolQuoteTokenAccount);

  console.log('\nPool reserves:');
  console.log('  Base:', baseReserve.value.uiAmount);
  console.log('  Quote:', quoteReserve.value.uiAmount);
  console.log('  LP supply:', poolState.lpSupply.toString());

  // Calculate expected LP tokens
  const expectedLpTokens = calculateLpTokensForDeposit(
    baseAmount,
    quoteAmount,
    BigInt(baseReserve.value.amount),
    BigInt(quoteReserve.value.amount),
    poolState.lpSupply
  );
  console.log('\nExpected LP tokens:', expectedLpTokens.toString());

  // Calculate min LP tokens with slippage
  const minLpTokens = expectedLpTokens - (expectedLpTokens * BigInt(slippageBps) / 10000n);

  // Get user token accounts
  const userBaseAta = getAssociatedTokenAddressSync(poolState.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolState.quoteMint, payer.publicKey);
  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, payer.publicKey);

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Check if user LP ATA exists
  const userLpAtaInfo = await connection.getAccountInfo(userLpAta);
  if (!userLpAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userLpAta,
        payer.publicKey,
        poolState.lpMint
      )
    );
  }

  // Build deposit instruction
  const depositDiscriminator = Buffer.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]);
  const depositData = Buffer.alloc(8 + 8 + 8 + 8);
  depositDiscriminator.copy(depositData, 0);
  depositData.writeBigUInt64LE(minLpTokens, 8);    // lpTokenAmount (minimum to receive)
  depositData.writeBigUInt64LE(baseAmount, 16);   // maxBaseAmount
  depositData.writeBigUInt64LE(quoteAmount, 24);  // maxQuoteAmount

  const depositInstruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
      { pubkey: poolState.lpMint, isSigner: false, isWritable: true },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  tx.add(depositInstruction);

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

  console.log('\n=== Liquidity Added Successfully ===');
  console.log('Signature:', signature);

  return signature;
}

// Remove liquidity from pool
async function removeLiquidity(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  lpTokenAmount: bigint,
  slippageBps: number = 500
): Promise<string> {
  console.log('\n=== Removing Liquidity ===');

  // Fetch pool state
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error('Pool not found');
  }

  const poolState = parsePoolState(poolInfo.data);

  // Get pool reserves
  const baseReserve = await connection.getTokenAccountBalance(poolState.poolBaseTokenAccount);
  const quoteReserve = await connection.getTokenAccountBalance(poolState.poolQuoteTokenAccount);

  console.log('LP tokens to burn:', lpTokenAmount.toString());
  console.log('Current LP supply:', poolState.lpSupply.toString());

  // Calculate expected withdrawal amounts
  const { baseAmount, quoteAmount } = calculateWithdrawalAmounts(
    lpTokenAmount,
    BigInt(baseReserve.value.amount),
    BigInt(quoteReserve.value.amount),
    poolState.lpSupply
  );

  console.log('Expected base out:', baseAmount.toString());
  console.log('Expected quote out:', quoteAmount.toString());

  // Apply slippage
  const minBaseAmount = baseAmount - (baseAmount * BigInt(slippageBps) / 10000n);
  const minQuoteAmount = quoteAmount - (quoteAmount * BigInt(slippageBps) / 10000n);

  // Get user token accounts
  const userBaseAta = getAssociatedTokenAddressSync(poolState.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolState.quoteMint, payer.publicKey);
  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, payer.publicKey);

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Build withdraw instruction
  const withdrawDiscriminator = Buffer.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22]);
  const withdrawData = Buffer.alloc(8 + 8 + 8 + 8);
  withdrawDiscriminator.copy(withdrawData, 0);
  withdrawData.writeBigUInt64LE(lpTokenAmount, 8);   // lpTokenAmount to burn
  withdrawData.writeBigUInt64LE(minBaseAmount, 16);  // minBaseAmountOut
  withdrawData.writeBigUInt64LE(minQuoteAmount, 24); // minQuoteAmountOut

  const withdrawInstruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
      { pubkey: poolState.lpMint, isSigner: false, isWritable: true },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: withdrawData,
  });

  tx.add(withdrawInstruction);

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

  console.log('\n=== Liquidity Removed Successfully ===');
  console.log('Signature:', signature);

  return signature;
}

// Get user's LP position
async function getLpPosition(
  connection: Connection,
  wallet: PublicKey,
  pool: PublicKey
): Promise<void> {
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error('Pool not found');
  }

  const poolState = parsePoolState(poolInfo.data);

  const userLpAta = getAssociatedTokenAddressSync(poolState.lpMint, wallet);

  try {
    const lpBalance = await connection.getTokenAccountBalance(userLpAta);

    // Get pool reserves
    const baseReserve = await connection.getTokenAccountBalance(poolState.poolBaseTokenAccount);
    const quoteReserve = await connection.getTokenAccountBalance(poolState.poolQuoteTokenAccount);

    const userLpAmount = BigInt(lpBalance.value.amount);

    // Calculate user's share
    const { baseAmount, quoteAmount } = calculateWithdrawalAmounts(
      userLpAmount,
      BigInt(baseReserve.value.amount),
      BigInt(quoteReserve.value.amount),
      poolState.lpSupply
    );

    const sharePercent = (Number(userLpAmount) / Number(poolState.lpSupply)) * 100;

    console.log('\n=== Your LP Position ===');
    console.log('LP tokens:', lpBalance.value.uiAmount);
    console.log('Pool share:', sharePercent.toFixed(4), '%');
    console.log('Base value:', baseAmount.toString());
    console.log('Quote value:', quoteAmount.toString());
  } catch (error) {
    console.log('No LP position found');
  }
}

// Example usage
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const walletPath = process.env.WALLET_PATH || './keypair.json';
  const wallet = loadWallet(walletPath);
  console.log('Wallet:', wallet.publicKey.toString());

  // Example pool address (replace with actual)
  const pool = new PublicKey('YOUR_POOL_ADDRESS');

  // Check LP position
  await getLpPosition(connection, wallet.publicKey, pool);

  // Add liquidity
  // await addLiquidity(connection, wallet, pool, 1000000n, 1000000000n);

  // Remove liquidity
  // await removeLiquidity(connection, wallet, pool, 1000000n);
}

main().catch(console.error);
