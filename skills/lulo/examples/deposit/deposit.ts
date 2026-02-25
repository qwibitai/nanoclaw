/**
 * Lulo Deposit Examples
 *
 * This file demonstrates various ways to deposit tokens into Lulo
 * for yield optimization on Solana.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';

// Configuration
const LULO_API_URL = 'https://api.lulo.fi';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// Token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Types
interface DepositParams {
  owner: string;
  mintAddress: string;
  amount: number;
  depositType: 'protected' | 'boosted' | 'regular';
  priorityFee?: number;
}

interface LuloTransactionResponse {
  transaction: string;
  lastValidBlockHeight: number;
  blockhash?: string;
}

/**
 * Generate a deposit transaction from Lulo API
 */
async function generateDepositTransaction(
  params: DepositParams
): Promise<LuloTransactionResponse> {
  const { owner, mintAddress, amount, depositType, priorityFee = 500000 } = params;

  const response = await fetch(
    `${LULO_API_URL}/v1/generate.transactions.deposit?priorityFee=${priorityFee}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LULO_API_KEY!,
      },
      body: JSON.stringify({
        owner,
        mintAddress,
        depositType,
        amount,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Deposit generation failed: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Execute a deposit to Lulo
 */
async function deposit(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number,
  depositType: 'protected' | 'boosted' | 'regular' = 'protected'
): Promise<string> {
  console.log(`Depositing ${amount} to Lulo (${depositType})...`);

  // Generate deposit transaction from API
  const { transaction: serializedTx } = await generateDepositTransaction({
    owner: wallet.publicKey.toBase58(),
    mintAddress,
    amount,
    depositType,
  });

  // Deserialize the transaction
  const txBuffer = Buffer.from(serializedTx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);

  // Sign the transaction
  transaction.sign([wallet]);

  // Send and confirm
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  console.log(`Deposit successful: ${signature}`);
  return signature;
}

/**
 * Example 1: Protected Deposit (safest option)
 *
 * Protected deposits earn stable yields and are automatically covered
 * against protocol failures by Boosted deposits.
 */
async function protectedDeposit(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const amount = 100_000_000; // 100 USDC (6 decimals)

  return deposit(connection, wallet, USDC_MINT, amount, 'protected');
}

/**
 * Example 2: Boosted Deposit (higher yields)
 *
 * Boosted deposits earn higher APY by providing coverage for Protected deposits.
 * Note: 48-hour withdrawal cooldown applies.
 */
async function boostedDeposit(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const amount = 500_000_000; // 500 USDC (6 decimals)

  return deposit(connection, wallet, USDC_MINT, amount, 'boosted');
}

/**
 * Example 3: Regular/Custom Deposit
 *
 * Custom deposits give you control over which protocols receive your funds.
 * No automatic protection - direct exposure to selected protocols.
 */
async function customDeposit(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const amount = 1_000_000_000; // 1000 USDC (6 decimals)

  return deposit(connection, wallet, USDC_MINT, amount, 'regular');
}

/**
 * Example 4: SOL Deposit
 *
 * Deposit native SOL for yield optimization.
 * Minimum: 1 SOL
 */
async function solDeposit(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const amount = 1_000_000_000; // 1 SOL (9 decimals)

  return deposit(connection, wallet, SOL_MINT, amount, 'protected');
}

/**
 * Example 5: Deposit with Custom Priority Fee
 *
 * Use higher priority fees during network congestion.
 */
async function depositWithPriorityFee(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const amount = 100_000_000; // 100 USDC

  const { transaction: serializedTx } = await generateDepositTransaction({
    owner: wallet.publicKey.toBase58(),
    mintAddress: USDC_MINT,
    amount,
    depositType: 'protected',
    priorityFee: 1_000_000, // 1M microlamports (higher priority)
  });

  const txBuffer = Buffer.from(serializedTx, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([wallet]);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  return signature;
}

/**
 * Example 6: Check Balance Before Deposit
 *
 * Always verify sufficient balance before attempting deposit.
 */
async function depositWithBalanceCheck(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number
): Promise<string> {
  // Get token account balance
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(mintAddress) }
  );

  if (tokenAccounts.value.length === 0) {
    throw new Error('No token account found for this mint');
  }

  const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
  const numericBalance = parseInt(balance);

  if (numericBalance < amount) {
    throw new Error(
      `Insufficient balance: ${numericBalance} < ${amount}`
    );
  }

  console.log(`Balance check passed: ${numericBalance} >= ${amount}`);
  return deposit(connection, wallet, mintAddress, amount, 'protected');
}

/**
 * Main execution
 */
async function main() {
  // Initialize connection
  const connection = new Connection(RPC_URL, 'confirmed');

  // Load wallet from environment or file
  const secretKey = JSON.parse(process.env.WALLET_SECRET_KEY || '[]');
  const wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));

  console.log('Wallet:', wallet.publicKey.toBase58());

  try {
    // Example: Protected deposit of 100 USDC
    const signature = await protectedDeposit(connection, wallet);
    console.log('Transaction signature:', signature);
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);
  } catch (error) {
    console.error('Deposit failed:', error);
    throw error;
  }
}

// Run if executed directly
main().catch(console.error);

export {
  deposit,
  generateDepositTransaction,
  protectedDeposit,
  boostedDeposit,
  customDeposit,
  solDeposit,
  depositWithPriorityFee,
  depositWithBalanceCheck,
};
