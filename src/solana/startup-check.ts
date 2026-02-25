/**
 * Solana Startup Check
 * Ensures Solana is configured before SolClaw starts
 */

import { isSolanaConfigured } from './config.js';
import { logger } from '../logger.js';
import chalk from 'chalk';

/**
 * Check if Solana is configured and exit if not
 * Call this at startup in src/index.ts
 */
export async function requireSolanaConfig(): Promise<void> {
  logger.info('Checking Solana configuration...');

  const isConfigured = await isSolanaConfigured();

  if (!isConfigured) {
    console.error(chalk.red('\n❌ Solana not configured!\n'));
    console.error(chalk.white('SolClaw requires Solana to be set up before starting.\n'));
    console.error(chalk.yellow('Run the following command to configure your wallet:\n'));
    console.error(chalk.cyan('  npm run setup:solana\n'));
    console.error(chalk.gray('Or run the full setup:\n'));
    console.error(chalk.cyan('  npm run setup\n'));

    logger.error('Solana not configured. Exiting.');
    process.exit(1);
  }

  logger.info('✓ Solana configuration found');
}

/**
 * Optional version - warns but doesn't exit
 */
export async function checkSolanaConfig(): Promise<boolean> {
  const isConfigured = await isSolanaConfigured();

  if (isConfigured) {
    logger.info('✓ Solana features enabled');
  } else {
    logger.warn('⚠ Solana not configured. Some features will be disabled.');
    logger.warn('Run: npm run setup:solana');
  }

  return isConfigured;
}
