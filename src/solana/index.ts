/**
 * Solana Agent Kit Integration
 * Main export file for Solana functionality
 */

export { SolanaAgent, createSolanaAgent } from './agent.js';
export type { SolanaAgentConfig, SolanaAgentOptions } from './agent.js';
export {
  loadSolanaConfig,
  loadAgentConfig,
  configToAgentConfig,
  isSolanaConfigured,
} from './config.js';
export type { SolanaConfig } from './config.js';

// Re-export common token mints for convenience
export const COMMON_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
} as const;
