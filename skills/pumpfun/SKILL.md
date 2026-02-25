---
name: pumpfun
creator: raunit-dev
description: Complete PumpFun Protocol guide for building token launches, bonding curves, and AMM integrations on Solana. Covers Pump Program (token creation, buy/sell on bonding curves), PumpSwap AMM (liquidity pools, swaps), fee structures, creator fees, and SDK integration.
---

# PumpFun Protocol Integration Guide

A comprehensive guide for building applications with PumpFun - Solana's leading token launch and AMM protocol enabling instant trading without initial liquidity.

## Overview

PumpFun is a token launch and trading protocol on Solana offering:
- **Pump Program** - Create SPL tokens with instant trading on bonding curves
- **PumpSwap (AMM)** - Constant-product automated market maker for graduated tokens
- **Creator Fees** - Automatic fee distribution to token creators
- **Token2022 Support** - Modern token standard via `create_v2` instruction
- **Mayhem Mode** - Special mode for enhanced token launches

## Program IDs

| Program | Address |
|---------|---------|
| Pump Program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| Pump Fees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |
| Mayhem Program | `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` |

## Quick Start

### Installation

```bash
# Install PumpFun SDKs
npm install @pump-fun/pump-sdk @pump-fun/pump-swap-sdk

# Or with pnpm
pnpm add @pump-fun/pump-sdk @pump-fun/pump-swap-sdk
```

### Basic Setup

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Setup connection
const connection = new Connection('https://api.mainnet-beta.solana.com');
const wallet = Keypair.fromSecretKey(bs58.decode('YOUR_SECRET_KEY'));

// Program addresses
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
```

## Pump Program (Bonding Curves)

The Pump program enables creation of SPL tokens with instant trading on a bonding curve without requiring initial liquidity.

### How Bonding Curves Work

1. **Token Creation** - Create a token with initial virtual reserves
2. **Trading** - Users buy/sell on the bonding curve using Uniswap V2 formula
3. **Graduation** - When market cap threshold is reached, liquidity migrates to PumpSwap
4. **LP Burn** - LP tokens are burned, making liquidity permanent

### Global Configuration

```typescript
interface Global {
  initialized: boolean;
  authority: PublicKey;
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: bigint;  // Default: 1,073,000,000,000,000
  initialVirtualSolReserves: bigint;    // Default: 30,000,000,000 (30 SOL)
  initialRealTokenReserves: bigint;     // Default: 793,100,000,000,000
  tokenTotalSupply: bigint;             // Default: 1,000,000,000,000,000
  feeBasisPoints: bigint;               // Default: 100 (1%)
  creatorFeeBasisPoints: bigint;        // Creator fee percentage
}
```

### Bonding Curve Account

```typescript
interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;        // Token creator address
  isMayhemMode: boolean;     // Mayhem mode flag
}
```

### Deriving PDAs

```typescript
import { PublicKey } from '@solana/web3.js';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Derive bonding curve PDA
function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

// Derive associated bonding curve (token account)
function getAssociatedBondingCurve(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('associated-bonding-curve'),
      mint.toBuffer()
    ],
    PUMP_PROGRAM_ID
  );
}

// Derive creator vault PDA
function getCreatorVaultPDA(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

// Derive global account PDA
function getGlobalPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM_ID
  );
}
```

### Create Token (Legacy SPL)

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

async function createToken(
  connection: Connection,
  payer: Keypair,
  name: string,
  symbol: string,
  uri: string
): Promise<string> {
  const mint = Keypair.generate();

  const [bondingCurve] = getBondingCurvePDA(mint.publicKey);
  const [associatedBondingCurve] = getAssociatedBondingCurve(mint.publicKey);
  const [global] = getGlobalPDA();

  // Metaplex metadata PDA
  const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  const [metadata] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );

  // Build create instruction data
  const nameBuffer = Buffer.from(name);
  const symbolBuffer = Buffer.from(symbol);
  const uriBuffer = Buffer.from(uri);

  const data = Buffer.alloc(
    8 + 4 + nameBuffer.length + 4 + symbolBuffer.length + 4 + uriBuffer.length
  );

  // Write discriminator for 'create' instruction
  const discriminator = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);
  discriminator.copy(data, 0);

  let offset = 8;
  data.writeUInt32LE(nameBuffer.length, offset);
  offset += 4;
  nameBuffer.copy(data, offset);
  offset += nameBuffer.length;

  data.writeUInt32LE(symbolBuffer.length, offset);
  offset += 4;
  symbolBuffer.copy(data, offset);
  offset += symbolBuffer.length;

  data.writeUInt32LE(uriBuffer.length, offset);
  offset += 4;
  uriBuffer.copy(data, offset);

  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer, mint);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature);

  return mint.publicKey.toBase58();
}
```

### Create Token V2 (Token2022)

```typescript
// create_v2 uses Token2022 program instead of legacy Metaplex
// Account structure (14 accounts):
const createV2Accounts = [
  'mint',                    // 0: New token mint (signer, writable)
  'mintAuthority',           // 1: Mint authority PDA
  'bondingCurve',            // 2: Bonding curve PDA (writable)
  'associatedBondingCurve',  // 3: Token account for bonding curve (writable)
  'global',                  // 4: Global config
  'user',                    // 5: Creator/payer (signer, writable)
  'systemProgram',           // 6: System program
  'token2022Program',        // 7: Token2022 program
  'associatedTokenProgram',  // 8: Associated token program
  'rent',                    // 9: Rent sysvar
  'mayhemProgram',           // 10: Mayhem program ID (for mayhem mode)
  'mayhemFeeRecipient',      // 11: Mayhem fee recipient
  'eventAuthority',          // 12: Event authority
  'program',                 // 13: Pump program
];
```

### Buy Tokens on Bonding Curve

```typescript
interface BuyArgs {
  amount: bigint;        // Token amount to buy
  maxSolCost: bigint;    // Maximum SOL to spend (slippage protection)
}

async function buyTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  amount: bigint,
  maxSolCost: bigint
): Promise<string> {
  const [bondingCurve] = getBondingCurvePDA(mint);
  const [associatedBondingCurve] = getAssociatedBondingCurve(mint);
  const [global] = getGlobalPDA();

  // Get bonding curve data to find creator
  const bondingCurveData = await connection.getAccountInfo(bondingCurve);
  // Parse to get creator address...
  const creator = parseCreatorFromBondingCurve(bondingCurveData);
  const [creatorVault] = getCreatorVaultPDA(creator);

  // User's associated token account
  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

  // Fee recipient (from global config)
  const feeRecipient = new PublicKey('FEE_RECIPIENT_ADDRESS');

  // Build buy instruction
  const data = Buffer.alloc(8 + 8 + 8);
  const discriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  const instruction = new TransactionInstruction({
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
      // Fee config accounts (required since September 2025)
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfigPDA, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Check if account extension needed (account size < 150 bytes)
  const accountInfo = await connection.getAccountInfo(bondingCurve);
  if (accountInfo && accountInfo.data.length < 150) {
    // Prepend extendAccount instruction
    const extendIx = createExtendAccountInstruction(bondingCurve);
    const tx = new Transaction().add(extendIx, instruction);
  } else {
    const tx = new Transaction().add(instruction);
  }

  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature);

  return signature;
}
```

### Sell Tokens on Bonding Curve

```typescript
interface SellArgs {
  amount: bigint;        // Token amount to sell
  minSolOutput: bigint;  // Minimum SOL to receive (slippage protection)
}

async function sellTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  amount: bigint,
  minSolOutput: bigint
): Promise<string> {
  const [bondingCurve] = getBondingCurvePDA(mint);
  const [associatedBondingCurve] = getAssociatedBondingCurve(mint);
  const [global] = getGlobalPDA();

  const bondingCurveData = await connection.getAccountInfo(bondingCurve);
  const creator = parseCreatorFromBondingCurve(bondingCurveData);
  const [creatorVault] = getCreatorVaultPDA(creator);

  const userAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const feeRecipient = new PublicKey('FEE_RECIPIENT_ADDRESS');

  const data = Buffer.alloc(8 + 8 + 8);
  const discriminator = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(minSolOutput, 16);

  const instruction = new TransactionInstruction({
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
      // Fee config accounts
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfigPDA, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  const signature = await connection.sendRawTransaction(tx.serialize());
  return signature;
}
```

### Calculate Price (Bonding Curve Math)

```typescript
// Uniswap V2 constant product formula: x * y = k
// Quote: SOL -> Tokens

interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
}

function calculateBuyQuote(
  state: BondingCurveState,
  solAmountIn: bigint,
  feeBasisPoints: bigint = 100n
): bigint {
  // Calculate net SOL after fees
  const netSol = (solAmountIn * 10000n) / (10000n + feeBasisPoints);

  // Calculate tokens out using constant product formula
  // tokensOut = (netSol * virtualTokenReserves) / (virtualSolReserves + netSol)
  const tokensOut = (netSol * state.virtualTokenReserves) /
                   (state.virtualSolReserves + netSol);

  // Cap at real token reserves
  return tokensOut > state.realTokenReserves ? state.realTokenReserves : tokensOut;
}

function calculateSellQuote(
  state: BondingCurveState,
  tokenAmountIn: bigint,
  feeBasisPoints: bigint = 100n
): bigint {
  // Calculate SOL out using constant product formula
  // solOut = (tokenAmountIn * virtualSolReserves) / (virtualTokenReserves + tokenAmountIn)
  const grossSol = (tokenAmountIn * state.virtualSolReserves) /
                  (state.virtualTokenReserves + tokenAmountIn);

  // Deduct fees
  const netSol = (grossSol * (10000n - feeBasisPoints)) / 10000n;

  // Cap at real SOL reserves
  return netSol > state.realSolReserves ? state.realSolReserves : netSol;
}

function calculateMarketCap(state: BondingCurveState, tokenSupply: bigint): bigint {
  // marketCap = virtualSolReserves * mintSupply / virtualTokenReserves
  return (state.virtualSolReserves * tokenSupply) / state.virtualTokenReserves;
}
```

### Migration to PumpSwap

When a bonding curve completes (real tokens exhausted), liquidity can be migrated to PumpSwap:

```typescript
async function migrateToAMM(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey
): Promise<string> {
  const [bondingCurve] = getBondingCurvePDA(mint);

  // Migrate instruction is permissionless - anyone can call it
  // after bonding curve is complete
  const discriminator = Buffer.from([0x9d, 0xaf, 0x1e, 0x65, 0xe8, 0x69, 0x9b, 0x26]);

  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      // ... migration accounts including PumpSwap pool creation
    ],
    data: discriminator,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  return await connection.sendRawTransaction(tx.serialize());
}
```

## PumpSwap (AMM)

PumpSwap is a constant-product AMM for tokens that have graduated from the bonding curve.

### Global Config

```typescript
// GlobalConfig address
const GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

interface GlobalConfig {
  admin: PublicKey;
  lpFeeBasisPoints: number;          // 20 bps (0.2%)
  protocolFeeBasisPoints: number;    // 5 bps (0.05%)
  coinCreatorFeeBasisPoints: number; // Creator fee
  disableFlags: number;              // Operation disable flags
  protocolFeeRecipients: PublicKey[]; // 8 fee recipients for load balancing
  tokenIncentivesEnabled: boolean;
}
```

### Pool Account

```typescript
interface Pool {
  bump: number;
  poolCreator: PublicKey;
  baseMint: PublicKey;          // Token mint
  quoteMint: PublicKey;         // Usually WSOL
  lpMint: PublicKey;            // LP token mint
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;             // Tracks original LP supply (independent of burns)
  coinCreator: PublicKey;       // Creator for fee distribution
  isMayhemMode: boolean;        // Mayhem mode flag
}
```

### Deriving Pool PDAs

```typescript
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

// Derive pool PDA
function getPoolPDA(
  index: number,
  creator: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): [PublicKey, number] {
  const indexBuffer = Buffer.alloc(2);
  indexBuffer.writeUInt16LE(index);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      indexBuffer,
      creator.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    PUMP_AMM_PROGRAM_ID
  );
}

// Derive LP mint PDA
function getLpMintPDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), pool.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

// Derive pool token account PDA
function getPoolTokenAccountPDA(pool: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_token_account'), pool.toBuffer(), mint.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

// Derive creator vault authority PDA
function getCreatorVaultAuthorityPDA(coinCreator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}
```

### Swap on PumpSwap

```typescript
interface SwapArgs {
  baseAmountIn: bigint;    // Amount of base token (for sell)
  quoteAmountIn: bigint;   // Amount of quote token (for buy)
  minAmountOut: bigint;    // Minimum output (slippage protection)
}

async function swapOnPumpSwap(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
  isBuy: boolean
): Promise<string> {
  const poolData = await fetchPoolData(connection, pool);

  const userBaseAta = getAssociatedTokenAddressSync(
    poolData.baseMint,
    payer.publicKey
  );
  const userQuoteAta = getAssociatedTokenAddressSync(
    poolData.quoteMint,
    payer.publicKey
  );

  const [creatorVaultAuthority] = getCreatorVaultAuthorityPDA(poolData.coinCreator);
  const creatorVaultAta = getAssociatedTokenAddressSync(
    poolData.quoteMint,
    creatorVaultAuthority,
    true // allowOwnerOffCurve
  );

  // Build swap instruction
  const data = Buffer.alloc(8 + 8 + 8 + 8);
  const discriminator = isBuy
    ? Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]) // buy
    : Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]); // sell

  discriminator.copy(data, 0);
  data.writeBigUInt64LE(isBuy ? 0n : amountIn, 8);      // baseAmountIn
  data.writeBigUInt64LE(isBuy ? amountIn : 0n, 16);     // quoteAmountIn
  data.writeBigUInt64LE(minAmountOut, 24);              // minAmountOut

  const instruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: poolData.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolData.quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: poolData.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolData.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // Creator fee accounts (indexes 17-18, required if pool.dataLen < 300)
      { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
      { pubkey: creatorVaultAuthority, isSigner: false, isWritable: false },
      // Fee config
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfigPDA, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Check if account extension needed
  const poolInfo = await connection.getAccountInfo(pool);
  if (poolInfo && poolInfo.data.length < 300) {
    const extendIx = createExtendAccountInstruction(pool);
    const tx = new Transaction().add(extendIx, instruction);
  } else {
    const tx = new Transaction().add(instruction);
  }

  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  return await connection.sendRawTransaction(tx.serialize());
}
```

### Add Liquidity

```typescript
async function addLiquidity(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  baseAmount: bigint,
  quoteAmount: bigint,
  minLpTokens: bigint
): Promise<string> {
  const poolData = await fetchPoolData(connection, pool);

  const userBaseAta = getAssociatedTokenAddressSync(poolData.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolData.quoteMint, payer.publicKey);
  const userLpAta = getAssociatedTokenAddressSync(poolData.lpMint, payer.publicKey);

  const data = Buffer.alloc(8 + 8 + 8 + 8);
  const discriminator = Buffer.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(baseAmount, 8);
  data.writeBigUInt64LE(quoteAmount, 16);
  data.writeBigUInt64LE(minLpTokens, 24);

  const instruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolData.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolData.quoteMint, isSigner: false, isWritable: false },
      { pubkey: poolData.lpMint, isSigner: false, isWritable: true },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: poolData.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolData.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  return await connection.sendRawTransaction(tx.serialize());
}
```

### Remove Liquidity

```typescript
async function removeLiquidity(
  connection: Connection,
  payer: Keypair,
  pool: PublicKey,
  lpTokenAmount: bigint,
  minBaseOut: bigint,
  minQuoteOut: bigint
): Promise<string> {
  const poolData = await fetchPoolData(connection, pool);

  const userBaseAta = getAssociatedTokenAddressSync(poolData.baseMint, payer.publicKey);
  const userQuoteAta = getAssociatedTokenAddressSync(poolData.quoteMint, payer.publicKey);
  const userLpAta = getAssociatedTokenAddressSync(poolData.lpMint, payer.publicKey);

  const data = Buffer.alloc(8 + 8 + 8 + 8);
  const discriminator = Buffer.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22]);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(lpTokenAmount, 8);
  data.writeBigUInt64LE(minBaseOut, 16);
  data.writeBigUInt64LE(minQuoteOut, 24);

  const instruction = new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolData.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolData.quoteMint, isSigner: false, isWritable: false },
      { pubkey: poolData.lpMint, isSigner: false, isWritable: true },
      { pubkey: userBaseAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userLpAta, isSigner: false, isWritable: true },
      { pubkey: poolData.poolBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolData.poolQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer);

  return await connection.sendRawTransaction(tx.serialize());
}
```

## Fee Structure

### Dynamic Fee Tiers

Fees are calculated based on market capitalization in lamports:

```typescript
interface FeeTier {
  marketCapLamportsThreshold: bigint;
  fees: Fees;
}

interface Fees {
  lpFeeBps: number;        // LP provider fee
  protocolFeeBps: number;  // Protocol fee
  creatorFeeBps: number;   // Creator fee
}

// Fee calculation for bonding curves
function calculateBondingCurveMarketCap(
  virtualSolReserves: bigint,
  mintSupply: bigint,
  virtualTokenReserves: bigint
): bigint {
  return (virtualSolReserves * mintSupply) / virtualTokenReserves;
}

// Fee calculation for AMM pools
function calculatePoolMarketCap(
  quoteReserve: bigint,
  baseMintSupply: bigint,
  baseReserve: bigint
): bigint {
  return (quoteReserve * baseMintSupply) / baseReserve;
}

// Get applicable fee tier
function getFeeTier(marketCap: bigint, feeTiers: FeeTier[]): Fees {
  // Sort tiers by threshold descending
  const sortedTiers = [...feeTiers].sort(
    (a, b) => Number(b.marketCapLamportsThreshold - a.marketCapLamportsThreshold)
  );

  for (const tier of sortedTiers) {
    if (marketCap >= tier.marketCapLamportsThreshold) {
      return tier.fees;
    }
  }

  // Return default/lowest tier
  return sortedTiers[sortedTiers.length - 1].fees;
}
```

### Fee Sharing Configuration

```typescript
interface SharingConfig {
  status: 'Active' | 'Paused';
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: Shareholder[];
}

interface Shareholder {
  address: PublicKey;
  shareBps: number;  // Share in basis points (total must equal 10000)
}

// Create fee sharing config
async function createFeeSharingConfig(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  shareholders: Shareholder[]
): Promise<string> {
  // Validate shares sum to 10000 bps (100%)
  const totalShares = shareholders.reduce((sum, s) => sum + s.shareBps, 0);
  if (totalShares !== 10000) {
    throw new Error('Shareholder shares must sum to 10000 bps');
  }

  // Build create_fee_sharing_config instruction
  // ...
}
```

### Collecting Creator Fees

```typescript
// Collect fees from bonding curve
async function collectBondingCurveCreatorFee(
  connection: Connection,
  creator: Keypair
): Promise<string> {
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );

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

  const tx = new Transaction().add(instruction);
  tx.feePayer = creator.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(creator);

  return await connection.sendRawTransaction(tx.serialize());
}

// Collect fees from PumpSwap pool
async function collectPoolCreatorFee(
  connection: Connection,
  coinCreator: Keypair,
  pool: PublicKey
): Promise<string> {
  const poolData = await fetchPoolData(connection, pool);

  const [creatorVaultAuthority] = getCreatorVaultAuthorityPDA(coinCreator.publicKey);
  const creatorVaultAta = getAssociatedTokenAddressSync(
    poolData.quoteMint,
    creatorVaultAuthority,
    true
  );
  const creatorWalletAta = getAssociatedTokenAddressSync(
    poolData.quoteMint,
    coinCreator.publicKey
  );

  // Build collect_coin_creator_fee instruction
  // ...
}
```

## SDK Usage

### Using PumpAmmSdk

```typescript
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';

const sdk = new PumpAmmSdk(connection);

// Pool creation with autocomplete
const initialPrice = sdk.createAutocompleteInitialPoolPrice(
  baseAmount,
  quoteAmount
);

const createIxs = await sdk.createPoolInstructions({
  index: 0,
  creator: payer.publicKey,
  baseMint: tokenMint,
  quoteMint: WSOL_MINT,
  baseAmountIn: baseAmount,
  quoteAmountIn: quoteAmount,
});

// Deposit autocomplete (base input changed)
const depositCalc = sdk.depositAutocompleteBaseInput({
  pool: poolAddress,
  baseAmountIn: userBaseInput,
  slippageBps: 50, // 0.5%
});
console.log('Quote needed:', depositCalc.quoteAmountIn);
console.log('LP tokens:', depositCalc.lpTokensOut);

// Deposit autocomplete (quote input changed)
const depositCalc2 = sdk.depositAutocompleteQuoteInput({
  pool: poolAddress,
  quoteAmountIn: userQuoteInput,
  slippageBps: 50,
});

// Execute deposit
const depositIxs = await sdk.depositInstructions({
  pool: poolAddress,
  user: payer.publicKey,
  lpTokenAmountOut: depositCalc.lpTokensOut,
  maxBaseAmountIn: depositCalc.baseAmountIn,
  maxQuoteAmountIn: depositCalc.quoteAmountIn,
});

// Swap autocomplete
const swapCalc = sdk.swapAutocompleteBaseInput({
  pool: poolAddress,
  baseAmountIn: sellAmount,
  slippageBps: 100, // 1%
});
console.log('Quote out:', swapCalc.quoteAmountOut);

// Execute swap
const swapIxs = await sdk.swapInstructions({
  pool: poolAddress,
  user: payer.publicKey,
  baseAmountIn: sellAmount,
  quoteAmountIn: 0n,
  minAmountOut: swapCalc.minQuoteAmountOut,
});

// Withdraw
const withdrawCalc = sdk.withdrawAutocomplete({
  pool: poolAddress,
  lpTokenAmountIn: lpTokens,
  slippageBps: 50,
});
console.log('Base out:', withdrawCalc.baseAmountOut);
console.log('Quote out:', withdrawCalc.quoteAmountOut);

const withdrawIxs = await sdk.withdrawInstructions({
  pool: poolAddress,
  user: payer.publicKey,
  lpTokenAmountIn: lpTokens,
  minBaseAmountOut: withdrawCalc.minBaseAmountOut,
  minQuoteAmountOut: withdrawCalc.minQuoteAmountOut,
});
```

## Account Extension

Both Pump and PumpSwap programs require account extension when account sizes have been increased:

```typescript
// Check and extend bonding curve account (size < 150 bytes)
async function ensureBondingCurveExtended(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<TransactionInstruction | null> {
  const accountInfo = await connection.getAccountInfo(bondingCurve);

  if (accountInfo && accountInfo.data.length < 150) {
    return createExtendAccountInstruction(PUMP_PROGRAM_ID, bondingCurve);
  }

  return null;
}

// Check and extend pool account (size < 300 bytes)
async function ensurePoolExtended(
  connection: Connection,
  pool: PublicKey
): Promise<TransactionInstruction | null> {
  const accountInfo = await connection.getAccountInfo(pool);

  if (accountInfo && accountInfo.data.length < 300) {
    return createExtendAccountInstruction(PUMP_AMM_PROGRAM_ID, pool);
  }

  return null;
}

function createExtendAccountInstruction(
  programId: PublicKey,
  account: PublicKey
): TransactionInstruction {
  const discriminator = Buffer.from([0x9a, 0x3f, 0x2c, 0x8b, 0x45, 0xe7, 0x12, 0xd6]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
    ],
    data: discriminator,
  });
}
```

## Mayhem Mode

Mayhem mode is a special token launch mode with different fee recipients:

```typescript
const MAYHEM_PROGRAM_ID = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');

// Mayhem fee recipients (randomly rotated for load balancing)
const MAYHEM_FEE_RECIPIENTS = [
  'DzPPWKfYYMuHxR98xhPkYSp7KHsLpcLZU8tHCqXjC3HG',
  '5AbGBKS6NHKcTFyJaZCk3dbMRNFG3y6kkN4y7Rp3iHCk',
  'DWM9EuZ3e9cRYdHYRKwsCqXFKgn4jUNkUPEAyNE2Dxnc',
  '9BUPJ65gFVaGQKyXiR6xSE1DdLRqkUMv9HJvL8wGfJaL',
];

// Check if token is in mayhem mode
function isMayhemMode(bondingCurve: BondingCurve): boolean {
  return bondingCurve.isMayhemMode;
}

// Get correct fee recipient based on mayhem mode
function getFeeRecipient(
  bondingCurve: BondingCurve,
  defaultFeeRecipient: PublicKey
): PublicKey {
  if (bondingCurve.isMayhemMode) {
    // Randomly select from mayhem recipients
    const index = Math.floor(Math.random() * MAYHEM_FEE_RECIPIENTS.length);
    return new PublicKey(MAYHEM_FEE_RECIPIENTS[index]);
  }
  return defaultFeeRecipient;
}
```

## Token Incentives

PumpFun offers volume-based token incentives:

```typescript
// Initialize user volume accumulator
async function initUserVolumeAccumulator(
  connection: Connection,
  payer: Keypair
): Promise<string> {
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume'), payer.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );

  // Build init_user_volume_accumulator instruction
  // ...
}

// Claim token incentives
async function claimTokenIncentives(
  connection: Connection,
  user: Keypair
): Promise<string> {
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume'), user.publicKey.toBuffer()],
    PUMP_PROGRAM_ID
  );

  // Build claim_token_incentives instruction
  // ...
}
```

## Compute Units Optimization

```typescript
// Recommended static CU limit for buy/sell operations
const RECOMMENDED_CU_LIMIT = 100_000;

// Add compute budget instructions
import { ComputeBudgetProgram } from '@solana/web3.js';

function addComputeBudget(
  tx: Transaction,
  units: number = 100_000,
  microLamports: number = 10_000
): Transaction {
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  );
  return tx;
}
```

## Error Handling

```typescript
// Common PumpFun errors
enum PumpError {
  SlippageExceeded = 6001,
  InsufficientFunds = 6002,
  BondingCurveComplete = 6003,
  BondingCurveNotComplete = 6004,
  InvalidAmount = 6005,
  MathOverflow = 6006,
  Unauthorized = 6007,
}

function handlePumpError(error: any): string {
  const code = error?.code || error?.message?.match(/custom program error: 0x(\w+)/)?.[1];

  switch (parseInt(code, 16)) {
    case PumpError.SlippageExceeded:
      return 'Transaction failed: Slippage tolerance exceeded. Try increasing slippage.';
    case PumpError.InsufficientFunds:
      return 'Insufficient funds for this transaction.';
    case PumpError.BondingCurveComplete:
      return 'Bonding curve is complete. Trade on PumpSwap instead.';
    case PumpError.BondingCurveNotComplete:
      return 'Bonding curve not yet complete. Cannot migrate.';
    default:
      return `Transaction failed: ${error.message}`;
  }
}
```

## Best Practices

### Transaction Building
- Always check account sizes before buy/sell and prepend `extendAccount` if needed
- Use static CU limit of 100,000 for buy/sell operations
- Include proper slippage protection (1-5% recommended)
- Use appropriate fee recipients based on mayhem mode status

### Fee Handling
- Always include fee config accounts (required since September 2025)
- For mayhem mode tokens, pass mayhem fee recipient at correct account index
- Check market cap tier for accurate fee calculation

### Creator Fees
- Creator fees accumulate in creator vault PDAs
- Use `collectCreatorFee` to withdraw accumulated fees
- Fees apply to non-completed bonding curves and canonical PumpSwap pools

### Security
- Never expose private keys
- Validate all user inputs
- Use devnet for testing before mainnet
- Implement proper error handling

## Resources

- **Public Docs**: https://github.com/pump-fun/pump-public-docs
- **IDL Files**: https://github.com/pump-fun/pump-public-docs/tree/main/idl
- **Pump SDK**: `@pump-fun/pump-sdk` on npm
- **PumpSwap SDK**: `@pump-fun/pump-swap-sdk` on npm

## Skill Structure

```
pumpfun/
├── SKILL.md                              # This file
├── resources/
│   ├── pump-program-reference.md         # Bonding curve program API
│   ├── pump-swap-reference.md            # AMM program API
│   ├── fee-structure.md                  # Fee calculation and tiers
│   └── program-addresses.md              # All program addresses
├── examples/
│   ├── bonding-curve/
│   │   ├── create-token.ts               # Token creation example
│   │   └── buy-sell.ts                   # Buy/sell on bonding curves
│   ├── swap/
│   │   └── swap.ts                       # PumpSwap trading
│   ├── liquidity/
│   │   └── add-remove.ts                 # Add/remove liquidity
│   └── creator-fees/
│       └── collect-fees.ts               # Fee collection
├── templates/
│   └── pumpfun-setup.ts                  # Starter template
└── docs/
    └── troubleshooting.md                # Common issues
```
