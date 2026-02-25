/**
 * PumpFun: Swap on PumpSwap AMM
 *
 * This example demonstrates how to swap tokens on PumpSwap AMM.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
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
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

// WSOL mint
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Pool state interface
interface PoolState {
  bump: number;
  poolCreator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  coinCreator: PublicKey;
}

// Load wallet
function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// Parse pool account data
function parsePoolState(data: Buffer): PoolState {
  let offset = 8; // Skip discriminator

  const bump = data.readUInt8(offset);
  offset += 1;

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
  offset += 8;

  const coinCreator = new PublicKey(data.slice(offset, offset + 32));

  return {
    bump,
    poolCreator,
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
    coinCreator,
  };
}

// Get creator vault authority PDA
function getCreatorVaultAuthorityPDA(coinCreator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

// Get fee config PDA
function getFeeConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    PUMP_FEES_PROGRAM_ID
  );
}

// Calculate swap output (constant product)
function calculateSwapOutput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  totalFeeBps: number = 25 // 0.25% total fee
): bigint {
  const amountInAfterFee = amountIn * BigInt(10000 - totalFeeBps) / 10000n;
  const amountOut = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
  return amountOut;
}

// Buy base tokens with quote tokens
async function buyOnPumpSwap(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  quoteAmountIn: bigint,
  slippageBps: number = 500
): Promise<string> {
  console.log('\n=== Buying on PumpSwap ===');

  // Fetch pool state
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error('Pool not found');
  }

  const poolState = parsePoolState(poolInfo.data);
  console.log('Pool:', pool.toString());
  console.log('Base mint:', poolState.baseMint.toString());
  console.log('Quote mint:', poolState.quoteMint.toString());

  // Get pool reserves
  const baseReserve = await connection.getTokenAccountBalance(poolState.poolBaseTokenAccount);
  const quoteReserve = await connection.getTokenAccountBalance(poolState.poolQuoteTokenAccount);

  console.log('Base reserve:', baseReserve.value.uiAmount);
  console.log('Quote reserve:', quoteReserve.value.uiAmount);

  // Calculate expected output
  const expectedBaseOut = calculateSwapOutput(
    quoteAmountIn,
    BigInt(quoteReserve.value.amount),
    BigInt(baseReserve.value.amount)
  );
  console.log('Expected base tokens out:', expectedBaseOut.toString());

  // Calculate min output with slippage
  const minBaseOut = expectedBaseOut - (expectedBaseOut * BigInt(slippageBps) / 10000n);
  console.log('Min base out (with slippage):', minBaseOut.toString());

  // Get user token accounts
  const userBaseAta = getAssociatedTokenAddressSync(poolState.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolState.quoteMint, payer.publicKey);

  // Get creator vault
  const [creatorVaultAuthority] = getCreatorVaultAuthorityPDA(poolState.coinCreator);
  const creatorVaultAta = getAssociatedTokenAddressSync(
    poolState.quoteMint,
    creatorVaultAuthority,
    true
  );

  // Get fee config
  const [feeConfig] = getFeeConfigPDA();

  // Protocol fee recipients (simplified - in production get from global config)
  const protocolFeeRecipient = new PublicKey('11111111111111111111111111111111');

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Check if user base ATA exists
  const userBaseAtaInfo = await connection.getAccountInfo(userBaseAta);
  if (!userBaseAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userBaseAta,
        payer.publicKey,
        poolState.baseMint
      )
    );
  }

  // Check if pool account needs extension
  if (poolInfo.data.length < 300) {
    const extendDiscriminator = Buffer.from([0x9a, 0x3f, 0x2c, 0x8b, 0x45, 0xe7, 0x12, 0xd6]);
    tx.add(
      new TransactionInstruction({
        programId: PUMP_AMM_PROGRAM_ID,
        keys: [{ pubkey: pool, isSigner: false, isWritable: true }],
        data: extendDiscriminator,
      })
    );
  }

  // Build buy instruction
  const buyDiscriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
  const buyData = Buffer.alloc(8 + 8 + 8);
  buyDiscriminator.copy(buyData, 0);
  buyData.writeBigUInt64LE(minBaseOut, 8);      // baseAmountOut (minimum)
  buyData.writeBigUInt64LE(quoteAmountIn, 16);  // maxQuoteAmountIn

  const buyInstruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
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

// Sell base tokens for quote tokens
async function sellOnPumpSwap(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  baseAmountIn: bigint,
  slippageBps: number = 500
): Promise<string> {
  console.log('\n=== Selling on PumpSwap ===');

  // Fetch pool state
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    throw new Error('Pool not found');
  }

  const poolState = parsePoolState(poolInfo.data);

  // Get pool reserves
  const baseReserve = await connection.getTokenAccountBalance(poolState.poolBaseTokenAccount);
  const quoteReserve = await connection.getTokenAccountBalance(poolState.poolQuoteTokenAccount);

  // Calculate expected output
  const expectedQuoteOut = calculateSwapOutput(
    baseAmountIn,
    BigInt(baseReserve.value.amount),
    BigInt(quoteReserve.value.amount)
  );
  console.log('Expected quote out:', expectedQuoteOut.toString());

  // Calculate min output with slippage
  const minQuoteOut = expectedQuoteOut - (expectedQuoteOut * BigInt(slippageBps) / 10000n);

  // Get user token accounts
  const userBaseAta = getAssociatedTokenAddressSync(poolState.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolState.quoteMint, payer.publicKey);

  // Get creator vault
  const [creatorVaultAuthority] = getCreatorVaultAuthorityPDA(poolState.coinCreator);
  const creatorVaultAta = getAssociatedTokenAddressSync(
    poolState.quoteMint,
    creatorVaultAuthority,
    true
  );

  const [feeConfig] = getFeeConfigPDA();
  const protocolFeeRecipient = new PublicKey('11111111111111111111111111111111');

  // Build transaction
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })
  );

  // Build sell instruction
  const sellDiscriminator = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
  const sellData = Buffer.alloc(8 + 8 + 8);
  sellDiscriminator.copy(sellData, 0);
  sellData.writeBigUInt64LE(baseAmountIn, 8);   // baseAmountIn
  sellData.writeBigUInt64LE(minQuoteOut, 16);   // minQuoteAmountOut

  const sellInstruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
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

  // Example pool address (replace with actual)
  const pool = new PublicKey('YOUR_POOL_ADDRESS');

  // Buy with 0.01 SOL worth of quote tokens
  // await buyOnPumpSwap(connection, wallet, pool, BigInt(0.01 * 1e9));

  // Sell 1000 base tokens
  // await sellOnPumpSwap(connection, wallet, pool, 1000n);
}

main().catch(console.error);
