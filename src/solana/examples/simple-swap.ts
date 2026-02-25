#!/usr/bin/env tsx

/**
 * Simple Swap Example
 * Demonstrates how to swap SOL for USDC using Solana Agent Kit
 *
 * Usage: tsx src/solana/examples/simple-swap.ts
 */

import { createSolanaAgent, loadAgentConfig, COMMON_TOKENS } from '../index.js';
import chalk from 'chalk';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.solana' });

async function main() {
  try {
    console.log(chalk.cyan.bold('\n🦀 SolClaw - Simple Swap Example\n'));

    // Load agent
    console.log(chalk.yellow('Loading agent...'));
    const config = await loadAgentConfig();
    const agent = createSolanaAgent(config);
    console.log(chalk.green(`✓ Agent loaded: ${agent.publicKey}\n`));

    // Check balance
    console.log(chalk.yellow('Checking balance...'));
    const balance = await agent.getBalanceSOL();
    console.log(chalk.green(`✓ Balance: ${balance.toFixed(6)} SOL\n`));

    if (balance < 0.01) {
      console.log(chalk.red('❌ Insufficient balance for swap'));
      console.log(chalk.white('Please fund your wallet with at least 0.01 SOL'));
      console.log(chalk.gray(`  solana airdrop 1 ${agent.publicKey}`));
      process.exit(1);
    }

    // Swap configuration
    const amount = 0.01; // 0.01 SOL
    const outputMint = COMMON_TOKENS.USDC;
    const slippage = 50; // 0.5%

    console.log(chalk.yellow('Swap Details:'));
    console.log(chalk.white(`  Input: ${amount} SOL`));
    console.log(chalk.white(`  Output: USDC`));
    console.log(chalk.white(`  Slippage: ${slippage / 100}%\n`));

    // Confirm
    console.log(chalk.yellow('⚠️  This will execute a real transaction on mainnet!'));
    console.log(chalk.gray('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n'));

    await new Promise(resolve => setTimeout(resolve, 5000));

    // Execute swap
    console.log(chalk.yellow('Executing swap...'));
    const signature = await agent.swap(outputMint, amount, null, slippage);

    console.log(chalk.green.bold('\n✅ Swap successful!\n'));
    console.log(chalk.white('Transaction signature:'));
    console.log(chalk.cyan(signature));
    console.log(chalk.white('\nView on Solscan:'));
    console.log(chalk.cyan(`https://solscan.io/tx/${signature}\n`));

    // Check new balance
    const newBalance = await agent.getBalanceSOL();
    console.log(chalk.white(`New balance: ${newBalance.toFixed(6)} SOL`));
    console.log(chalk.gray(`Used: ${(balance - newBalance).toFixed(6)} SOL\n`));

  } catch (error: any) {
    console.error(chalk.red('\n❌ Swap failed:'), error.message);
    console.error(chalk.gray('\nCommon issues:'));
    console.error(chalk.white('  • Insufficient balance'));
    console.error(chalk.white('  • RPC rate limit'));
    console.error(chalk.white('  • Slippage too low'));
    console.error(chalk.white('  • Network congestion\n'));
    process.exit(1);
  }
}

main();
