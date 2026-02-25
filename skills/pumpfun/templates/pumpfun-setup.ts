/**
 * PumpFun SDK Setup Template
 *
 * This template provides a ready-to-use setup for PumpFun operations.
 * Copy this file and customize for your project.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  Commitment,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // RPC endpoint
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Commitment level
  commitment: 'confirmed' as Commitment,

  // Wallet path
  walletPath: process.env.WALLET_PATH || './keypair.json',

  // Default slippage (5%)
  defaultSlippageBps: 500,

  // Default compute units
  defaultComputeUnits: 100_000,

  // Default priority fee (microLamports)
  defaultPriorityFee: 10_000,
};

// ============================================================================
// PROGRAM IDS
// ============================================================================

export const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);

export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);

export const PUMP_FEES_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
);

export const MAYHEM_PROGRAM_ID = new PublicKey(
  'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e'
);

export const PUMP_SWAP_GLOBAL_CONFIG = new PublicKey(
  'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw'
);

export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

// ============================================================================
// INTERFACES
// ============================================================================

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
}

export interface PoolState {
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

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpact: number;
  fee: bigint;
}

// ============================================================================
// WALLET LOADING
// ============================================================================

function loadWallet(): Keypair {
  const walletPath = path.resolve(CONFIG.walletPath);

  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found: ${walletPath}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// ============================================================================
// PDA DERIVATIONS
// ============================================================================

export function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

export function getAssociatedBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('associated-bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

export function getGlobalPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM_ID
  );
}

export function getCreatorVaultPDA(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

export function getFeeConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    PUMP_FEES_PROGRAM_ID
  );
}

export function getPumpSwapCreatorVaultAuthorityPDA(
  coinCreator: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

// ============================================================================
// PUMPFUN CLIENT CLASS
// ============================================================================

export class PumpFunClient {
  private connection: Connection;
  private wallet: Keypair;

  constructor(wallet?: Keypair) {
    this.connection = new Connection(CONFIG.rpcUrl, CONFIG.commitment);
    this.wallet = wallet || loadWallet();
  }

  // Get wallet address
  get address(): PublicKey {
    return this.wallet.publicKey;
  }

  // Get connection
  get rpc(): Connection {
    return this.connection;
  }

  // ========================================================================
  // BONDING CURVE METHODS
  // ========================================================================

  async getBondingCurveState(mint: PublicKey): Promise<BondingCurveState | null> {
    const [bondingCurve] = getBondingCurvePDA(mint);
    const accountInfo = await this.connection.getAccountInfo(bondingCurve);

    if (!accountInfo) return null;

    return this.parseBondingCurve(accountInfo.data);
  }

  private parseBondingCurve(data: Buffer): BondingCurveState {
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
    offset += 32;
    const isMayhemMode = data.length > offset && data.readUInt8(offset) === 1;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
      isMayhemMode,
    };
  }

  // ========================================================================
  // QUOTE CALCULATIONS
  // ========================================================================

  calculateBuyQuote(
    state: BondingCurveState,
    solAmountIn: bigint,
    feeBps: bigint = 100n
  ): SwapQuote {
    const netSol = (solAmountIn * 10000n) / (10000n + feeBps);
    const fee = solAmountIn - netSol;

    const tokensOut = (netSol * state.virtualTokenReserves) /
                      (state.virtualSolReserves + netSol);

    const cappedTokensOut = tokensOut > state.realTokenReserves
      ? state.realTokenReserves
      : tokensOut;

    const priceImpact = Number(netSol) / Number(state.virtualSolReserves) * 100;

    const minAmountOut = cappedTokensOut -
      (cappedTokensOut * BigInt(CONFIG.defaultSlippageBps) / 10000n);

    return {
      amountIn: solAmountIn,
      amountOut: cappedTokensOut,
      minAmountOut,
      priceImpact,
      fee,
    };
  }

  calculateSellQuote(
    state: BondingCurveState,
    tokenAmountIn: bigint,
    feeBps: bigint = 100n
  ): SwapQuote {
    const grossSol = (tokenAmountIn * state.virtualSolReserves) /
                     (state.virtualTokenReserves + tokenAmountIn);

    const netSol = (grossSol * (10000n - feeBps)) / 10000n;
    const fee = grossSol - netSol;

    const cappedSol = netSol > state.realSolReserves
      ? state.realSolReserves
      : netSol;

    const priceImpact = Number(tokenAmountIn) / Number(state.virtualTokenReserves) * 100;

    const minAmountOut = cappedSol -
      (cappedSol * BigInt(CONFIG.defaultSlippageBps) / 10000n);

    return {
      amountIn: tokenAmountIn,
      amountOut: cappedSol,
      minAmountOut,
      priceImpact,
      fee,
    };
  }

  // ========================================================================
  // TRANSACTION HELPERS
  // ========================================================================

  async sendTransaction(
    instructions: TransactionInstruction[],
    signers: Keypair[] = []
  ): Promise<string> {
    const tx = new Transaction();

    // Add compute budget
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: CONFIG.defaultComputeUnits,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: CONFIG.defaultPriorityFee,
      })
    );

    tx.add(...instructions);

    tx.feePayer = this.wallet.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const allSigners = [this.wallet, ...signers];

    return await sendAndConfirmTransaction(
      this.connection,
      tx,
      allSigners,
      { commitment: CONFIG.commitment }
    );
  }

  async ensureAta(
    mint: PublicKey,
    owner: PublicKey = this.wallet.publicKey
  ): Promise<TransactionInstruction | null> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const accountInfo = await this.connection.getAccountInfo(ata);

    if (!accountInfo) {
      return createAssociatedTokenAccountInstruction(
        this.wallet.publicKey,
        ata,
        owner,
        mint
      );
    }

    return null;
  }

  // ========================================================================
  // UTILITY METHODS
  // ========================================================================

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9;
  }

  async getTokenBalance(mint: PublicKey): Promise<number> {
    const ata = getAssociatedTokenAddressSync(mint, this.wallet.publicKey);

    try {
      const balance = await this.connection.getTokenAccountBalance(ata);
      return Number(balance.value.uiAmount);
    } catch {
      return 0;
    }
  }
}

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

async function main() {
  const client = new PumpFunClient();

  console.log('=== PumpFun Client ===');
  console.log('Wallet:', client.address.toString());

  const balance = await client.getBalance();
  console.log('SOL Balance:', balance, 'SOL');

  // Example: Get bonding curve state
  // const mint = new PublicKey('YOUR_TOKEN_MINT');
  // const state = await client.getBondingCurveState(mint);
  // if (state) {
  //   console.log('Bonding curve state:', state);
  //
  //   // Calculate buy quote
  //   const quote = client.calculateBuyQuote(state, BigInt(0.1 * 1e9));
  //   console.log('Buy quote:', quote);
  // }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
