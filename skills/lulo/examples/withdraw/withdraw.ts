/**
 * Lulo Withdrawal Examples
 *
 * This file demonstrates various ways to withdraw tokens from Lulo.
 * Note: Boosted deposits have a 48-hour withdrawal cooldown.
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

// Configuration
const LULO_API_URL = 'https://api.lulo.fi';
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// Token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Types
interface WithdrawParams {
  owner: string;
  mintAddress: string;
  amount: number;
  withdrawType: 'protected' | 'boosted' | 'regular';
  priorityFee?: number;
}

interface LuloTransactionResponse {
  transaction: string;
  lastValidBlockHeight: number;
}

interface PendingWithdrawal {
  mint: string;
  amount: number;
  withdrawType: string;
  initiatedAt: number;
  availableAt: number;
  cooldownRemaining: number;
}

/**
 * Generate a withdrawal transaction from Lulo API
 */
async function generateWithdrawTransaction(
  params: WithdrawParams
): Promise<LuloTransactionResponse> {
  const { owner, mintAddress, amount, withdrawType, priorityFee = 500000 } = params;

  const response = await fetch(
    `${LULO_API_URL}/v1/generate.transactions.withdraw?priorityFee=${priorityFee}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LULO_API_KEY!,
      },
      body: JSON.stringify({
        owner,
        mintAddress,
        withdrawType,
        amount,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Withdrawal generation failed: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Execute a withdrawal from Lulo
 */
async function withdraw(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number,
  withdrawType: 'protected' | 'boosted' | 'regular' = 'protected'
): Promise<string> {
  console.log(`Withdrawing ${amount} from Lulo (${withdrawType})...`);

  // Generate withdrawal transaction from API
  const { transaction: serializedTx } = await generateWithdrawTransaction({
    owner: wallet.publicKey.toBase58(),
    mintAddress,
    amount,
    withdrawType,
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

  console.log(`Withdrawal successful: ${signature}`);
  return signature;
}

/**
 * Example 1: Protected Withdrawal (instant)
 *
 * Protected deposits can be withdrawn instantly at any time.
 */
async function protectedWithdraw(
  connection: Connection,
  wallet: Keypair,
  amount: number
): Promise<string> {
  return withdraw(connection, wallet, USDC_MINT, amount, 'protected');
}

/**
 * Example 2: Boosted Withdrawal (48h cooldown)
 *
 * Boosted deposits require a 48-hour cooldown period.
 * This initiates the withdrawal request.
 */
async function boostedWithdraw(
  connection: Connection,
  wallet: Keypair,
  amount: number
): Promise<string> {
  console.log('Note: Boosted withdrawals have a 48-hour cooldown period');
  return withdraw(connection, wallet, USDC_MINT, amount, 'boosted');
}

/**
 * Example 3: Custom/Regular Withdrawal
 *
 * Withdraw from custom deposit positions.
 */
async function customWithdraw(
  connection: Connection,
  wallet: Keypair,
  amount: number
): Promise<string> {
  return withdraw(connection, wallet, USDC_MINT, amount, 'regular');
}

/**
 * Example 4: Check Pending Withdrawals
 *
 * Get list of pending withdrawals (useful for Boosted deposits).
 */
async function getPendingWithdrawals(
  walletAddress: string
): Promise<PendingWithdrawal[]> {
  const response = await fetch(
    `${LULO_API_URL}/v1/account/${walletAddress}/pending-withdrawals`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch pending withdrawals');
  }

  const data = await response.json();
  return data.pendingWithdrawals || [];
}

/**
 * Example 5: Complete Boosted Withdrawal
 *
 * After the 48-hour cooldown, complete the withdrawal.
 */
async function completeBoostedWithdraw(
  connection: Connection,
  wallet: Keypair
): Promise<string | null> {
  // Check pending withdrawals
  const pending = await getPendingWithdrawals(wallet.publicKey.toBase58());

  const availableWithdrawal = pending.find(
    (w) => w.withdrawType === 'boosted' && w.cooldownRemaining <= 0
  );

  if (!availableWithdrawal) {
    console.log('No boosted withdrawals available to complete');
    if (pending.length > 0) {
      console.log('Pending withdrawals:', pending);
    }
    return null;
  }

  // Complete the withdrawal
  return withdraw(
    connection,
    wallet,
    availableWithdrawal.mint,
    availableWithdrawal.amount,
    'boosted'
  );
}

/**
 * Example 6: Withdraw All from Position
 *
 * Withdraw entire balance from a specific position type.
 */
async function withdrawAll(
  connection: Connection,
  wallet: Keypair,
  withdrawType: 'protected' | 'boosted' | 'regular'
): Promise<string> {
  // Get account data to find balance
  const response = await fetch(
    `${LULO_API_URL}/v1/account/${wallet.publicKey.toBase58()}`,
    {
      headers: {
        'x-api-key': process.env.LULO_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch account data');
  }

  const account = await response.json();
  const position = account.positions?.find(
    (p: any) =>
      p.mint === USDC_MINT &&
      p.depositType === withdrawType
  );

  if (!position || position.balance <= 0) {
    throw new Error(`No ${withdrawType} USDC position found`);
  }

  console.log(`Withdrawing all ${position.balance} from ${withdrawType} position`);
  return withdraw(connection, wallet, USDC_MINT, position.balance, withdrawType);
}

/**
 * Example 7: Withdraw with Retry Logic
 *
 * Implement retry logic for failed withdrawals.
 */
async function withdrawWithRetry(
  connection: Connection,
  wallet: Keypair,
  mintAddress: string,
  amount: number,
  withdrawType: 'protected' | 'boosted' | 'regular',
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Withdrawal attempt ${attempt}/${maxRetries}`);
      return await withdraw(connection, wallet, mintAddress, amount, withdrawType);
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        // Wait before retry (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${delay}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Withdrawal failed after all retries');
}

/**
 * Example 8: Monitor Withdrawal Cooldown
 *
 * Monitor boosted withdrawal cooldown and notify when ready.
 */
async function monitorWithdrawalCooldown(
  walletAddress: string,
  checkInterval: number = 60000 // 1 minute
): Promise<void> {
  console.log('Monitoring withdrawal cooldowns...');

  const checkCooldowns = async () => {
    const pending = await getPendingWithdrawals(walletAddress);

    for (const withdrawal of pending) {
      if (withdrawal.cooldownRemaining <= 0) {
        console.log(`Withdrawal ready: ${withdrawal.amount} ${withdrawal.mint}`);
      } else {
        const hoursRemaining = withdrawal.cooldownRemaining / 3600;
        console.log(
          `Cooldown: ${hoursRemaining.toFixed(2)} hours remaining for ${withdrawal.amount}`
        );
      }
    }
  };

  // Initial check
  await checkCooldowns();

  // Set up interval
  setInterval(checkCooldowns, checkInterval);
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
    // Example: Withdraw 50 USDC from protected position
    const amount = 50_000_000; // 50 USDC
    const signature = await protectedWithdraw(connection, wallet, amount);

    console.log('Transaction signature:', signature);
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);
  } catch (error) {
    console.error('Withdrawal failed:', error);
    throw error;
  }
}

// Run if executed directly
main().catch(console.error);

export {
  withdraw,
  generateWithdrawTransaction,
  protectedWithdraw,
  boostedWithdraw,
  customWithdraw,
  getPendingWithdrawals,
  completeBoostedWithdraw,
  withdrawAll,
  withdrawWithRetry,
  monitorWithdrawalCooldown,
};
