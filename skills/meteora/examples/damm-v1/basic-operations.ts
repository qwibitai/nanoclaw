/**
 * Meteora DAMM v1 SDK Examples
 *
 * Demonstrates pool creation, liquidity operations, and swapping
 * using the DAMM v1 (Dynamic AMM) SDK.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import AmmImpl from "@meteora-ag/dynamic-amm";
import BN from "bn.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Common token mints
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Initialize connection
const connection = new Connection(RPC_URL);
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY || "[]"))
);

/**
 * Example 1: Initialize pool instance and get info
 */
async function getPoolInfo(poolAddress: PublicKey): Promise<void> {
  console.log("=== DAMM v1 Pool Info ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  // Get LP supply
  const lpSupply = await pool.getLpSupply();
  console.log(`LP Supply: ${lpSupply.toString()}`);

  // Get user balance
  const userBalance = await pool.getUserBalance(wallet.publicKey);
  console.log(`Your LP Balance: ${userBalance.toString()}`);

  // Pool tokens
  console.log(`Token A: ${pool.tokenAMint.toBase58()}`);
  console.log(`Token B: ${pool.tokenBMint.toBase58()}`);
}

/**
 * Example 2: Create a new constant product pool
 */
async function createPool(
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  configAddress: PublicKey
): Promise<string> {
  console.log("=== Create DAMM v1 Pool ===");

  console.log(`Token A: ${tokenAMint.toBase58()}`);
  console.log(`Token B: ${tokenBMint.toBase58()}`);
  console.log(`Token A Amount: ${tokenAAmount.toString()}`);
  console.log(`Token B Amount: ${tokenBAmount.toString()}`);

  const createPoolTx =
    await AmmImpl.createPermissionlessConstantProductPoolWithConfig(
      connection,
      wallet.publicKey,
      tokenAMint,
      tokenBMint,
      tokenAAmount,
      tokenBAmount,
      configAddress,
      {
        lockLiquidity: false,
        activationPoint: null, // Immediate activation
      }
    );

  const txId = await sendAndConfirmTransaction(connection, createPoolTx, [
    wallet,
  ]);

  console.log(`Pool created!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 3: Create memecoin pool with locked liquidity
 */
async function createMemecoinPool(
  tokenMint: PublicKey,
  quoteMint: PublicKey,
  tokenAmount: BN,
  quoteAmount: BN,
  configAddress: PublicKey
): Promise<string> {
  console.log("=== Create Memecoin Pool ===");

  console.log(`Token: ${tokenMint.toBase58()}`);
  console.log(`Quote (SOL/USDC): ${quoteMint.toBase58()}`);
  console.log("Liquidity will be locked for trust");

  const createPoolTx =
    await AmmImpl.createPermissionlessConstantProductMemecoinPoolWithConfig(
      connection,
      wallet.publicKey,
      tokenMint,
      quoteMint,
      tokenAmount,
      quoteAmount,
      configAddress,
      {
        lockLiquidity: true, // Lock for trust
      }
    );

  const txId = await sendAndConfirmTransaction(connection, createPoolTx, [
    wallet,
  ]);

  console.log(`Memecoin pool created with locked liquidity!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 4: Get swap quote
 */
async function getSwapQuote(
  poolAddress: PublicKey,
  inputMint: PublicKey,
  inputAmount: BN,
  slippageBps: number = 100
): Promise<void> {
  console.log("=== Swap Quote ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  const quote = pool.getSwapQuote(inputMint, inputAmount, slippageBps);

  console.log(`Input: ${inputAmount.toString()}`);
  console.log(`Output: ${quote.outAmount.toString()}`);
  console.log(`Min Output (with slippage): ${quote.minOutAmount.toString()}`);
  console.log(`Fee: ${quote.fee.toString()}`);
  console.log(`Price Impact: ${quote.priceImpact}%`);
}

/**
 * Example 5: Execute swap
 */
async function executeSwap(
  poolAddress: PublicKey,
  inputMint: PublicKey,
  inputAmount: BN,
  slippageBps: number = 100
): Promise<string> {
  console.log("=== Execute Swap ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  // Get quote first
  const quote = pool.getSwapQuote(inputMint, inputAmount, slippageBps);

  console.log(`Swapping ${inputAmount.toString()} for ${quote.outAmount.toString()}`);
  console.log(`Price impact: ${quote.priceImpact}%`);

  // Execute swap
  const swapTx = await pool.swap(
    wallet.publicKey,
    inputMint,
    inputAmount,
    quote.minOutAmount
  );

  const txId = await sendAndConfirmTransaction(connection, swapTx, [wallet]);

  console.log(`Swap complete!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 6: Add liquidity (deposit)
 */
async function addLiquidity(
  poolAddress: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  slippageBps: number = 100
): Promise<string> {
  console.log("=== Add Liquidity ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  // Get deposit quote
  const quote = pool.getDepositQuote(
    tokenAAmount,
    tokenBAmount,
    true, // Balanced deposit
    slippageBps
  );

  console.log(`Depositing:`);
  console.log(`  Token A: ${tokenAAmount.toString()}`);
  console.log(`  Token B: ${tokenBAmount.toString()}`);
  console.log(`Expected LP tokens: ${quote.lpAmount.toString()}`);

  // Execute deposit
  const depositTx = await pool.deposit(
    wallet.publicKey,
    tokenAAmount,
    tokenBAmount,
    quote.minLpAmount
  );

  const txId = await sendAndConfirmTransaction(connection, depositTx, [wallet]);

  console.log(`Liquidity added!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 7: Remove liquidity (withdraw)
 */
async function removeLiquidity(
  poolAddress: PublicKey,
  lpAmount: BN,
  slippageBps: number = 100
): Promise<string> {
  console.log("=== Remove Liquidity ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  // Get withdraw quote
  const quote = pool.getWithdrawQuote(lpAmount, slippageBps);

  console.log(`Withdrawing ${lpAmount.toString()} LP tokens`);
  console.log(`Expected Token A: ${quote.tokenAAmount.toString()}`);
  console.log(`Expected Token B: ${quote.tokenBAmount.toString()}`);

  // Execute withdrawal
  const withdrawTx = await pool.withdraw(
    wallet.publicKey,
    lpAmount,
    quote.minTokenAAmount,
    quote.minTokenBAmount
  );

  const txId = await sendAndConfirmTransaction(connection, withdrawTx, [
    wallet,
  ]);

  console.log(`Liquidity removed!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 8: Remove all liquidity
 */
async function removeAllLiquidity(
  poolAddress: PublicKey,
  slippageBps: number = 100
): Promise<string> {
  console.log("=== Remove All Liquidity ===");

  const pool = await AmmImpl.create(connection, poolAddress);

  // Get user's LP balance
  const lpBalance = await pool.getUserBalance(wallet.publicKey);

  if (lpBalance.isZero()) {
    console.log("No liquidity to remove");
    return "";
  }

  console.log(`Removing all ${lpBalance.toString()} LP tokens`);

  // Get withdraw quote
  const quote = pool.getWithdrawQuote(lpBalance, slippageBps);

  // Execute withdrawal
  const withdrawTx = await pool.withdraw(
    wallet.publicKey,
    lpBalance,
    quote.minTokenAAmount,
    quote.minTokenBAmount
  );

  const txId = await sendAndConfirmTransaction(connection, withdrawTx, [
    wallet,
  ]);

  console.log(`All liquidity removed!`);
  console.log(`Transaction: https://solscan.io/tx/${txId}`);

  return txId;
}

/**
 * Example 9: Complete trading workflow
 */
async function tradingWorkflow(poolAddress: PublicKey): Promise<void> {
  console.log("=== Trading Workflow ===\n");

  try {
    const pool = await AmmImpl.create(connection, poolAddress);

    // Step 1: Check pool state
    console.log("Step 1: Getting pool info...");
    const lpSupply = await pool.getLpSupply();
    console.log(`LP Supply: ${lpSupply.toString()}\n`);

    // Step 2: Add liquidity
    console.log("Step 2: Adding liquidity...");
    const tokenAAmount = new BN(100_000_000); // 0.1 SOL or token
    const tokenBAmount = new BN(100_000_000);

    const depositQuote = pool.getDepositQuote(
      tokenAAmount,
      tokenBAmount,
      true,
      100
    );

    const depositTx = await pool.deposit(
      wallet.publicKey,
      tokenAAmount,
      tokenBAmount,
      depositQuote.minLpAmount
    );
    await sendAndConfirmTransaction(connection, depositTx, [wallet]);
    console.log("Liquidity added\n");

    // Step 3: Execute a swap
    console.log("Step 3: Executing swap...");
    const swapAmount = new BN(10_000_000);
    const swapQuote = pool.getSwapQuote(pool.tokenAMint, swapAmount, 100);

    const swapTx = await pool.swap(
      wallet.publicKey,
      pool.tokenAMint,
      swapAmount,
      swapQuote.minOutAmount
    );
    await sendAndConfirmTransaction(connection, swapTx, [wallet]);
    console.log("Swap complete\n");

    // Step 4: Check updated balance
    console.log("Step 4: Checking LP balance...");
    const lpBalance = await pool.getUserBalance(wallet.publicKey);
    console.log(`Your LP Balance: ${lpBalance.toString()}\n`);

    // Step 5: Remove liquidity
    console.log("Step 5: Removing liquidity...");
    const withdrawQuote = pool.getWithdrawQuote(lpBalance, 100);

    const withdrawTx = await pool.withdraw(
      wallet.publicKey,
      lpBalance,
      withdrawQuote.minTokenAAmount,
      withdrawQuote.minTokenBAmount
    );
    await sendAndConfirmTransaction(connection, withdrawTx, [wallet]);
    console.log("Liquidity removed\n");

    console.log("=== Workflow Complete ===");
  } catch (error) {
    console.error("Workflow failed:", error);
    throw error;
  }
}

/**
 * Example 10: Work with multiple pools
 */
async function multiPoolOperations(
  poolAddresses: PublicKey[]
): Promise<void> {
  console.log("=== Multi-Pool Operations ===\n");

  // Create multiple pool instances
  const pools = await AmmImpl.createMultiple(connection, poolAddresses);

  console.log(`Loaded ${pools.length} pools\n`);

  for (const pool of pools) {
    const lpSupply = await pool.getLpSupply();
    const userBalance = await pool.getUserBalance(wallet.publicKey);

    console.log(`Pool: ${pool.address.toBase58()}`);
    console.log(`  LP Supply: ${lpSupply.toString()}`);
    console.log(`  Your Balance: ${userBalance.toString()}`);
    console.log("");
  }
}

// Main execution
async function main() {
  console.log("Meteora DAMM v1 SDK Examples\n");
  console.log(`Wallet: ${wallet.publicKey.toBase58()}\n`);

  // Example pool address (replace with actual)
  const POOL_ADDRESS = new PublicKey("YOUR_POOL_ADDRESS");

  // Uncomment examples to run:

  // await getPoolInfo(POOL_ADDRESS);
  // await getSwapQuote(POOL_ADDRESS, SOL_MINT, new BN(100_000_000), 100);
  // await executeSwap(POOL_ADDRESS, SOL_MINT, new BN(100_000_000), 100);
  // await addLiquidity(POOL_ADDRESS, new BN(100_000_000), new BN(100_000_000), 100);
  // await removeLiquidity(POOL_ADDRESS, new BN(50_000_000), 100);
  // await removeAllLiquidity(POOL_ADDRESS, 100);
  // await tradingWorkflow(POOL_ADDRESS);
}

main().catch(console.error);
